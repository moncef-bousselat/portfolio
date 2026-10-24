/*
 * The CloudFront distribution in front of the site bucket.
 *
 * Three cache behaviours:
 *   /api/*     the contact API (contact.tf), never cached.
 *   /_astro/*  content-hashed assets - a changed file has a new name, so
 *              they are cached for as long as CloudFront allows.
 *   default    everything else: HTML, the RSS feeds, the CV.
 *              Short-lived at the edge, and the deploy invalidates it.
 */

# Rewrites directory URLs to index.html and canonicalises host and path.
# The file is uploaded verbatim; see the comment at its top.
resource "aws_cloudfront_function" "viewer_request" {
  name    = "${var.project}-viewer-request"
  comment = "Directory index rewrite and canonical-URL redirects."
  runtime = "cloudfront-js-2.0"
  code    = file("${path.module}/functions/viewer-request.js")
  publish = true
}

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

/*
 * What the contact API receives from a visitor's request. Not Host: API
 * Gateway routes on its own hostname and rejects the site's. Not cookies or
 * query strings: the handler reads neither.
 *
 * CloudFront-Viewer-Address is added by CloudFront itself (viewer IP and
 * port), so unlike X-Forwarded-For a client cannot forge it; the handler
 * passes the IP on to Turnstile.
 */
resource "aws_cloudfront_origin_request_policy" "contact_api" {
  name    = "${var.project}-contact-api"
  comment = "Contact API: the body's Content-Type and the viewer address, nothing else."

  cookies_config {
    cookie_behavior = "none"
  }

  headers_config {
    header_behavior = "whitelist"

    headers {
      items = ["Content-Type", "CloudFront-Viewer-Address"]
    }
  }

  query_strings_config {
    query_string_behavior = "none"
  }
}

/*
 * HTML and the other unhashed files. Their URLs never change, so the edge
 * may only hold them briefly: a deploy invalidates the cache, but anything
 * that slips past an invalidation is stale for at most an hour.
 *
 * The TTLs bound what the origin's Cache-Control asks for; scripts/deploy.sh
 * sets that header on every upload. default_ttl applies only to an object
 * uploaded without one.
 */
resource "aws_cloudfront_cache_policy" "html" {
  name        = "${var.project}-html"
  comment     = "Unhashed site files: short edge TTL, no cookies, headers or query strings in the key."
  min_ttl     = 0
  default_ttl = 300
  max_ttl     = 3600

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true

    cookies_config {
      cookie_behavior = "none"
    }

    headers_config {
      header_behavior = "none"
    }

    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

/*
 * No WAF: the brief rules it out on cost. The one dynamic path, the contact
 * API, has its own throttling, reserved concurrency and Turnstile.
 *
 * No access logging: traffic is read from CloudFront's built-in console
 * reports, and logs would be a bucket of visitor IPs to look after.
 *
 * TLS: with a domain, the ACM certificate and TLSv1.2_2025 - TLS 1.2 or
 * 1.3, forward-secret AEAD ciphers only. Without one, the *.cloudfront.net
 * default certificate, which AWS pins to the TLSv1 policy; no other value is
 * accepted there.
 */
#trivy:ignore:AVD-AWS-0010
#trivy:ignore:AVD-AWS-0011
resource "aws_cloudfront_distribution" "site" {
  # At creation only: afterwards the kill switch (killswitch.tf) and the
  # Reopen site workflow own it, and an apply must not undo either.
  enabled             = true
  comment             = "${var.project} static site"
  default_root_object = "index.html"
  http_version        = "http2and3"
  is_ipv6_enabled     = true
  price_class         = var.price_class
  aliases             = local.site_aliases

  origin {
    origin_id                = "site"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  origin {
    origin_id   = "contact-api"
    domain_name = trimprefix(aws_apigatewayv2_api.contact.api_endpoint, "https://")

    # Proof the request came through CloudFront; contact.tf has why. Sent on
    # every request to this origin, overwriting any viewer header of the
    # same name.
    custom_header {
      name  = "x-origin-verify"
      value = random_password.origin_verify.result
    }

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id           = "site"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = aws_cloudfront_cache_policy.html.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.viewer_request.arn
    }
  }

  /*
   * The contact API. CloudFront only accepts fixed method sets, so GET and
   * the rest pass through too; API Gateway has no route for them and its 404
   * becomes the site's 404 page below. No function: the index rewrite is for
   * site paths.
   */
  ordered_cache_behavior {
    path_pattern               = "/api/*"
    target_origin_id           = "contact-api"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.contact_api.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  # Hashed assets are always real files, so they skip the function.
  ordered_cache_behavior {
    path_pattern               = "/_astro/*"
    target_origin_id           = "site"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  /*
   * A missing key is a 404 from S3, not a 403, because the bucket policy
   * grants this distribution s3:ListBucket (see bucket_policy.tf). That keeps
   * the mapping to 404 only, so a genuine 403 - a refused Turnstile token
   * from the contact API, say - is never dressed up as "page not found".
   * The contact API itself never answers 404 from its one route.
   *
   * A short error TTL, so a page that is published moments after someone
   * requested it does not stay a 404 at that edge for long.
   */
  custom_error_response {
    error_code            = 404
    response_code         = 404
    response_page_path    = "/404.html"
    error_caching_min_ttl = 60
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = !local.domain_enabled
    acm_certificate_arn            = local.domain_enabled ? aws_acm_certificate_validation.site[0].certificate_arn : null
    ssl_support_method             = local.domain_enabled ? "sni-only" : null
    minimum_protocol_version       = local.domain_enabled ? "TLSv1.2_2025" : "TLSv1"
  }

  lifecycle {
    ignore_changes = [enabled]
  }
}
