/*
 * Plan-shape tests for infra/main, run against mocked providers:
 *
 *   terraform init -backend=false && terraform test
 *
 * mock_provider means no AWS API is ever called and no credentials are
 * needed - these check the configuration's logic (which resources exist,
 * which certificate the distribution gets), not AWS's behaviour.
 */

# Generated values are random strings; anything the provider validates as an
# ARN needs a well-formed one. 123456789012 is AWS's documentation account.
mock_provider "aws" {
  mock_resource "aws_cloudfront_function" {
    defaults = {
      arn = "arn:aws:cloudfront::123456789012:function/portfolio-viewer-request"
    }
  }

  mock_resource "aws_cloudfront_distribution" {
    defaults = {
      arn            = "arn:aws:cloudfront::123456789012:distribution/EDFDVBD6EXAMPLE"
      domain_name    = "d111111abcdef8.cloudfront.net"
      hosted_zone_id = "Z2FDTNDATAQYW2"
    }
  }

  # Policy documents are rendered by the provider itself; a mock only needs
  # to hand the bucket policy valid JSON.
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{}"
    }
  }

  mock_resource "aws_s3_bucket" {
    defaults = {
      arn = "arn:aws:s3:::example-portfolio-site"
    }
  }

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
    }
  }

  mock_data "aws_partition" {
    defaults = {
      partition = "aws"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/portfolio-contact"
    }
  }

  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:eu-west-1:123456789012:log-group:/aws/lambda/portfolio-contact"
    }
  }

  mock_resource "aws_lambda_function" {
    defaults = {
      arn        = "arn:aws:lambda:eu-west-1:123456789012:function:portfolio-contact"
      invoke_arn = "arn:aws:apigateway:eu-west-1:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-west-1:123456789012:function:portfolio-contact/invocations"
    }
  }

  # SES always issues three Easy DKIM tokens.
  mock_data "aws_sesv2_email_identity" {
    defaults = {
      dkim_signing_attributes = [
        {
          tokens = ["tokena", "tokenb", "tokenc"]
        },
      ]
    }
  }

  mock_resource "aws_apigatewayv2_api" {
    defaults = {
      api_endpoint  = "https://a1b2c3d4e5.execute-api.eu-west-1.amazonaws.com"
      execution_arn = "arn:aws:execute-api:eu-west-1:123456789012:a1b2c3d4e5"
    }
  }

}

# random_password's result, fixed so assertions can name it.
mock_provider "random" {
  mock_resource "random_password" {
    defaults = {
      result = "mock-origin-verify-secret"
    }
  }
}

mock_provider "aws" {
  alias = "us_east_1"

  # Validation options as ACM returns them, for both names the runs use.
  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"
      domain_validation_options = [
        {
          domain_name           = "example.com"
          resource_record_name  = "_a1.example.com."
          resource_record_type  = "CNAME"
          resource_record_value = "_b1.acm-validations.aws."
        },
        {
          domain_name           = "www.example.com"
          resource_record_name  = "_a2.www.example.com."
          resource_record_type  = "CNAME"
          resource_record_value = "_b2.acm-validations.aws."
        },
      ]
    }
  }

  mock_resource "aws_acm_certificate_validation" {
    defaults = {
      certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000"
    }
  }
}

# terraform test also loads a local terraform.tfvars, so every variable is
# pinned here - otherwise the real domain would meet example.com mocks.
variables {
  aws_region          = "eu-west-1"
  project             = "portfolio"
  site_bucket_name    = "example-portfolio-site"
  tags                = {}
  price_class         = "PriceClass_100"
  domain_name         = null
  create_hosted_zone  = false
  enable_www_redirect = true
  budget_limit_usd    = 5
  budget_alert_email  = "alerts@example.com"
  dmarc_policy        = "none"

  # Runs without a domain need an explicit sender; domain runs that test
  # the contact@<domain> default set it back to null.
  contact_recipient_email = "owner@example.org"
  ses_from_email          = "contact@example.net"

  # At their defaults, which the runs below assert. Left unpinned, a local
  # terraform.tfvars that tunes them would fail those runs.
  turnstile_secret_parameter_name = null
  contact_throttle_rate_limit     = 1
  contact_throttle_burst_limit    = 5
  contact_reserved_concurrency    = 2
  log_retention_days              = 14

  contact_rate_limit_window_seconds = 300
}

run "without_a_domain" {
  command = apply

  assert {
    condition     = length(aws_cloudfront_distribution.site.aliases) == 0
    error_message = "No domain means no aliases on the distribution."
  }

  assert {
    condition     = one(aws_cloudfront_distribution.site.viewer_certificate).cloudfront_default_certificate
    error_message = "No domain means CloudFront's default certificate."
  }

  assert {
    condition     = length(aws_acm_certificate.site) == 0 && length(aws_route53_record.site) == 0
    error_message = "No domain means no certificate and no DNS records."
  }

  assert {
    condition     = output.site_url == "https://d111111abcdef8.cloudfront.net/"
    error_message = "Without a domain, the site URL is the distribution's own address."
  }

  assert {
    condition     = output.name_servers == null
    error_message = "No zone was created, so there are no name servers to report."
  }

  assert {
    condition     = aws_sesv2_email_identity.contact.email_identity == "contact@example.net" && length(aws_route53_record.ses_dkim) == 0
    error_message = "Without a domain, SES verifies the sender address itself, with no DKIM records."
  }

  assert {
    condition     = aws_lambda_function.contact.environment[0].variables.TURNSTILE_HOSTNAME == ""
    error_message = "Without a domain there is no hostname to pin Turnstile tokens to."
  }
}

run "apex_and_www_in_an_existing_zone" {
  command = apply

  variables {
    domain_name = "example.com"
  }

  assert {
    condition     = toset(aws_cloudfront_distribution.site.aliases) == toset(["example.com", "www.example.com"])
    error_message = "Both the apex and www should be aliases."
  }

  assert {
    condition     = aws_acm_certificate.site[0].domain_name == "example.com" && toset(aws_acm_certificate.site[0].subject_alternative_names) == toset(["www.example.com"])
    error_message = "The certificate should be for the apex, with www as a SAN."
  }

  assert {
    condition     = toset(keys(aws_route53_record.site)) == toset(["example.com A", "example.com AAAA", "www.example.com A", "www.example.com AAAA"])
    error_message = "Each name needs an A and an AAAA alias."
  }

  assert {
    condition     = toset(keys(aws_route53_record.certificate_validation)) == toset(["example.com", "www.example.com"])
    error_message = "Each certificate name needs its validation record."
  }

  assert {
    condition     = aws_route53_record.certificate_validation["www.example.com"].name == "_a2.www.example.com."
    error_message = "Each validation record must carry its own name's CNAME, not another's."
  }

  assert {
    condition     = one(aws_cloudfront_distribution.site.viewer_certificate).minimum_protocol_version == "TLSv1.2_2025"
    error_message = "A custom domain must enforce the TLS 1.2 floor."
  }

  assert {
    condition     = one(aws_cloudfront_distribution.site.viewer_certificate).ssl_support_method == "sni-only"
    error_message = "SNI only - a dedicated-IP certificate is billed monthly."
  }

  assert {
    condition     = length(aws_route53_zone.site) == 0 && length(data.aws_route53_zone.site) == 1
    error_message = "create_hosted_zone defaults to false, so the zone is looked up, not created."
  }
}

run "apex_only" {
  command = apply

  variables {
    domain_name         = "example.com"
    enable_www_redirect = false
  }

  assert {
    condition     = aws_cloudfront_distribution.site.aliases == toset(["example.com"])
    error_message = "Without www, the apex is the only alias."
  }

  assert {
    condition     = length(aws_acm_certificate.site[0].subject_alternative_names) == 0
    error_message = "Without www, the certificate has no SANs."
  }
}

run "creates_the_zone_when_asked" {
  command = apply

  variables {
    domain_name        = "example.com"
    create_hosted_zone = true
  }

  assert {
    condition     = length(aws_route53_zone.site) == 1 && length(data.aws_route53_zone.site) == 0
    error_message = "create_hosted_zone = true should create the zone and skip the lookup."
  }

  assert {
    condition     = output.site_url == "https://example.com/"
    error_message = "With a domain, the site URL is the apex."
  }
}

run "rejects_a_domain_with_a_scheme" {
  command = plan

  variables {
    domain_name = "https://example.com"
  }

  expect_failures = [var.domain_name]
}

run "rejects_a_site_bucket_name_s3_would_refuse" {
  command = plan

  variables {
    site_bucket_name = "Example_Bucket"
  }

  expect_failures = [var.site_bucket_name]
}

# --- Contact form ------------------------------------------------------------

run "contact_on_the_domain" {
  command = apply

  variables {
    domain_name    = "example.com"
    ses_from_email = null
  }

  assert {
    condition = [for record in aws_route53_record.ses_dkim : [record.name, record.type, one(record.records)]] == [
      ["tokena._domainkey.example.com", "CNAME", "tokena.dkim.amazonses.com"],
      ["tokenb._domainkey.example.com", "CNAME", "tokenb.dkim.amazonses.com"],
      ["tokenc._domainkey.example.com", "CNAME", "tokenc.dkim.amazonses.com"],
    ]
    error_message = "Each DKIM token needs its CNAME to amazonses.com."
  }

  assert {
    condition = aws_lambda_function.contact.environment[0].variables == tomap({
      MAIL_TRANSPORT             = "ses"
      MAIL_FROM                  = "contact@example.com"
      MAIL_TO                    = "owner@example.org"
      TURNSTILE_SECRET_PARAMETER = "/portfolio/turnstile-secret"
      TURNSTILE_HOSTNAME         = "example.com"
      ORIGIN_VERIFY_SECRET       = "mock-origin-verify-secret"
      RATE_LIMIT_TABLE           = "portfolio-contact-limits"
      RATE_LIMIT_WINDOW_SECONDS  = "300"
    })
    error_message = "The Lambda must send via SES, from contact@<domain>, to the configured recipient."
  }

  assert {
    condition     = aws_lambda_function.contact.runtime == "nodejs24.x" && aws_lambda_function.contact.architectures == tolist(["arm64"])
    error_message = "The handler runs on Node 24, arm64 - the same major as local development."
  }

  assert {
    condition = (
      aws_dynamodb_table.contact_limits.billing_mode == "PAY_PER_REQUEST"
      && aws_dynamodb_table.contact_limits.hash_key == "pk"
      && one(aws_dynamodb_table.contact_limits.ttl).attribute_name == "expiresAt"
      && one(aws_dynamodb_table.contact_limits.ttl).enabled
    )
    error_message = "The limit table is on demand, keyed by pk, and expires items through expiresAt."
  }

  assert {
    condition     = aws_lambda_function.contact.reserved_concurrent_executions == 2
    error_message = "Reserved concurrency defaults to 2."
  }

  assert {
    condition     = aws_cloudwatch_log_group.contact.retention_in_days == 14 && aws_cloudwatch_log_group.contact_api.retention_in_days == 14
    error_message = "Both log groups keep 14 days by default."
  }

  assert {
    condition     = aws_apigatewayv2_route.contact.route_key == "POST /api/contact"
    error_message = "The API has exactly one route, POST /api/contact."
  }

  assert {
    condition = (
      aws_apigatewayv2_stage.contact.default_route_settings[0].throttling_rate_limit == 1
      && aws_apigatewayv2_stage.contact.default_route_settings[0].throttling_burst_limit == 5
    )
    error_message = "The stage throttles at 1 request/s with a burst of 5 by default."
  }

  assert {
    condition     = aws_lambda_permission.contact.source_arn == "arn:aws:execute-api:eu-west-1:123456789012:a1b2c3d4e5/*/POST/api/contact"
    error_message = "API Gateway may invoke the function for the one route only."
  }
}

run "contact_through_cloudfront" {
  command = apply

  variables {
    domain_name = "example.com"
  }

  assert {
    condition     = one([for origin in aws_cloudfront_distribution.site.origin : origin.domain_name if origin.origin_id == "contact-api"]) == "a1b2c3d4e5.execute-api.eu-west-1.amazonaws.com"
    error_message = "The API origin is the execute-api hostname, without its scheme."
  }

  assert {
    condition = one([for origin in aws_cloudfront_distribution.site.origin : origin.custom_header if origin.origin_id == "contact-api"]) == toset([{
      name  = "x-origin-verify"
      value = "mock-origin-verify-secret"
    }])
    error_message = "CloudFront must send the Lambda's origin secret to the API, and only that header."
  }

  assert {
    condition = one([
      for behavior in aws_cloudfront_distribution.site.ordered_cache_behavior : behavior
      if behavior.path_pattern == "/api/*"
      && behavior.target_origin_id == "contact-api"
      && behavior.cache_policy_id == data.aws_cloudfront_cache_policy.caching_disabled.id
      && behavior.origin_request_policy_id == aws_cloudfront_origin_request_policy.contact_api.id
      && behavior.viewer_protocol_policy == "https-only"
      && contains(behavior.allowed_methods, "POST")
      && length(behavior.function_association) == 0
    ]) != null
    error_message = "/api/* must go to the API uncached, with its own request policy and no viewer-request function."
  }

  assert {
    condition     = toset(aws_cloudfront_origin_request_policy.contact_api.headers_config[0].headers[0].items) == toset(["Content-Type", "CloudFront-Viewer-Address"])
    error_message = "The API receives only Content-Type and the viewer address - never Host."
  }
}

run "contact_from_another_domain" {
  command = apply

  variables {
    domain_name    = "example.com"
    ses_from_email = "me@example.net"
  }

  assert {
    condition     = aws_sesv2_email_identity.contact.email_identity == "me@example.net" && length(aws_route53_record.ses_dkim) == 0
    error_message = "A sender off the site's domain is verified as an address, with no DKIM records in the site's zone."
  }

  assert {
    condition     = length(aws_route53_record.dmarc) == 0
    error_message = "With the sender off the domain, the site's domain gets no DMARC record from this stack."
  }
}

run "dmarc_on_the_domain" {
  command = apply

  variables {
    domain_name    = "example.com"
    ses_from_email = null
  }

  assert {
    condition = (
      one(aws_route53_record.dmarc).name == "_dmarc.example.com"
      && one(aws_route53_record.dmarc).type == "TXT"
      && one(aws_route53_record.dmarc).records == toset(["v=DMARC1; p=none; adkim=s; aspf=r"])
    )
    error_message = "The domain gets a report-only DMARC record, DKIM strict, no report address."
  }
}

run "dmarc_policy_reaches_the_record" {
  command = plan

  variables {
    domain_name    = "example.com"
    ses_from_email = null
    dmarc_policy   = "reject"
  }

  assert {
    condition     = one(aws_route53_record.dmarc).records == toset(["v=DMARC1; p=reject; adkim=s; aspf=r"])
    error_message = "dmarc_policy sets p=."
  }
}

run "no_dmarc_record_when_managed_elsewhere" {
  command = plan

  variables {
    domain_name    = "example.com"
    ses_from_email = null
    dmarc_policy   = null
  }

  assert {
    condition     = length(aws_route53_record.dmarc) == 0
    error_message = "dmarc_policy = null writes no record."
  }
}

run "rejects_an_unknown_dmarc_policy" {
  command = plan

  variables {
    domain_name  = "example.com"
    dmarc_policy = "monitor"
  }

  expect_failures = [var.dmarc_policy]
}

run "contact_limits_are_variables" {
  command = apply

  variables {
    domain_name                     = "example.com"
    contact_reserved_concurrency    = -1
    contact_throttle_rate_limit     = 2
    contact_throttle_burst_limit    = 10
    log_retention_days              = 30
    turnstile_secret_parameter_name = "/elsewhere/turnstile"
  }

  assert {
    condition     = aws_lambda_function.contact.reserved_concurrent_executions == -1
    error_message = "-1 removes the reservation, for accounts on the default concurrency quota."
  }

  assert {
    condition     = aws_apigatewayv2_stage.contact.default_route_settings[0].throttling_burst_limit == 10
    error_message = "Throttling follows its variables."
  }

  assert {
    condition     = aws_lambda_function.contact.environment[0].variables.TURNSTILE_SECRET_PARAMETER == "/elsewhere/turnstile"
    error_message = "The parameter name follows its variable."
  }
}

run "rejects_no_sender_without_a_domain" {
  command = plan

  variables {
    ses_from_email = null
  }

  expect_failures = [var.ses_from_email]
}

run "rejects_a_zero_reserved_concurrency" {
  command = plan

  variables {
    # 0 would disable the function outright.
    contact_reserved_concurrency = 0
  }

  expect_failures = [var.contact_reserved_concurrency]
}

run "rejects_a_relative_parameter_name" {
  command = plan

  variables {
    turnstile_secret_parameter_name = "portfolio/turnstile-secret"
  }

  expect_failures = [var.turnstile_secret_parameter_name]
}

run "rejects_a_rate_limit_window_too_short_to_mean_anything" {
  command = plan

  variables {
    contact_rate_limit_window_seconds = 30
  }

  expect_failures = [var.contact_rate_limit_window_seconds]
}

run "turns_the_rate_limit_off_with_zero" {
  command = plan

  variables {
    contact_rate_limit_window_seconds = 0
  }

  assert {
    condition     = aws_lambda_function.contact.environment[0].variables["RATE_LIMIT_WINDOW_SECONDS"] == "0"
    error_message = "0 reaches the Lambda, which then skips the limit."
  }
}
