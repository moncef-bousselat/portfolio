/*
 * The contact form's backend:
 *
 *   CloudFront /api/*  ->  API Gateway HTTP API  ->  Lambda  ->  SES
 *
 * Abuse and cost limits, all here: stage throttling, the Lambda's reserved
 * concurrency, a per-visitor limit table, a role that can send only from
 * the one sender to the one recipient, and short log retention. Turnstile, the honeypot and request
 * validation live in the handler (api/contact).
 *
 * The Turnstile secret is an SSM SecureString created by hand. Only its
 * name is used here - never a data source, which would copy the value into
 * state.
 *
 * The execute-api endpoint also answers directly, around CloudFront; it has
 * to, since CloudFront calls it. So CloudFront adds a secret header on the
 * way, and the handler refuses any request without it (403): every request
 * that does real work came through CloudFront, which is what makes its
 * CloudFront-Viewer-Address, the visitor's IP, trustworthy.
 */

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition

  contact_name = "${var.project}-contact"

  # contact@<domain> unless overridden. Without a domain, ses_from_email's
  # validation guarantees it is set.
  contact_from = var.ses_from_email != null ? var.ses_from_email : "contact@${var.domain_name}"

  # A sender on the site's own domain verifies the whole domain through
  # DKIM; any other sender verifies that one address.
  ses_domain_identity = local.domain_enabled ? endswith(local.contact_from, "@${var.domain_name}") : false
  ses_identity        = local.ses_domain_identity ? var.domain_name : local.contact_from

  turnstile_parameter_name = coalesce(var.turnstile_secret_parameter_name, "/${var.project}/turnstile-secret")
  turnstile_parameter_arn  = "arn:${local.partition}:ssm:${var.aws_region}:${local.account_id}:parameter${local.turnstile_parameter_name}"

  contact_bundle = "${path.module}/../../api/contact/dist/contact.zip"
}

/*
 * The x-origin-verify value. Unlike the Turnstile secret it does live in
 * state (and in the distribution and Lambda configuration): CloudFront
 * needs it in its config. It guards less: leaked, it lets a caller skip
 * CloudFront and pose as other IPs, while Turnstile and the throttle still
 * hold. Rotate with terraform apply -replace=random_password.origin_verify;
 * direct-to-API refusals briefly include real visitors while CloudFront
 * deploys the new value, a few minutes.
 */
resource "random_password" "origin_verify" {
  length  = 64
  special = false
}

# --- Per-visitor limit -------------------------------------------------------

/*
 * One item per visitor who sent a message in the last window, keyed by an
 * HMAC of their IP (api/contact/src/ratelimit.ts), never the IP itself.
 * Items expire through TTL; DynamoDB deletes them lazily, which the handler
 * allows for. On demand: a few writes a day cost nothing measurable.
 *
 * No point-in-time recovery: the items are worthless five minutes after
 * they are written, and restoring them would only re-block visitors. The
 * AWS-owned key encrypts them; a customer key would cost more per month than
 * the stack, to protect hashes that expire in minutes.
 */
#trivy:ignore:AVD-AWS-0024
#trivy:ignore:AVD-AWS-0025
resource "aws_dynamodb_table" "contact_limits" {
  name         = "${local.contact_name}-limits"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}

# --- SES ---------------------------------------------------------------------

resource "aws_sesv2_email_identity" "contact" {
  email_identity = local.ses_identity

  # Easy DKIM, with 2048-bit keys pinned rather than left to SES's default.
  # Only a domain identity signs; an address identity has no DKIM of its own.
  dynamic "dkim_signing_attributes" {
    for_each = local.ses_domain_identity ? [1] : []

    content {
      next_signing_key_length = "RSA_2048_BIT"
    }
  }
}

/*
 * Easy DKIM: SES hands out three tokens, each published as a CNAME. Counted
 * rather than for_each'd, since the tokens are only known after apply; SES
 * always issues exactly three.
 *
 * The tokens are read back through the data source rather than from the
 * resource: there they sit in a nested block, which terraform test's mock
 * provider cannot populate, and these records are worth testing.
 */
data "aws_sesv2_email_identity" "contact" {
  count = local.ses_domain_identity ? 1 : 0

  email_identity = aws_sesv2_email_identity.contact.email_identity
}

resource "aws_route53_record" "ses_dkim" {
  count = local.ses_domain_identity ? 3 : 0

  zone_id = local.zone_id
  name    = "${data.aws_sesv2_email_identity.contact[0].dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.domain_name}"
  type    = "CNAME"
  ttl     = 1800
  records = ["${data.aws_sesv2_email_identity.contact[0].dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

/*
 * DMARC: what receivers should do with mail that claims this domain in its
 * From but fails authentication. SES's mail passes through DKIM, signed as
 * exactly this domain (adkim=s). SPF is left relaxed: SES's bounce address
 * is on amazonses.com, so SPF never aligns and DMARC rests on DKIM alone.
 * No rua: no aggregate reports are requested.
 */
resource "aws_route53_record" "dmarc" {
  count = local.ses_domain_identity && var.dmarc_policy != null ? 1 : 0

  zone_id = local.zone_id
  name    = "_dmarc.${var.domain_name}"
  type    = "TXT"
  ttl     = 3600
  records = ["v=DMARC1; p=${var.dmarc_policy}; adkim=s; aspf=r"]
}

# --- Lambda ------------------------------------------------------------------

data "aws_iam_policy_document" "contact_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "contact" {
  name               = local.contact_name
  description        = "Contact form Lambda: send one email, read one parameter, write its own logs."
  assume_role_policy = data.aws_iam_policy_document.contact_assume.json
}

data "aws_iam_policy_document" "contact" {
  /*
   * identity/* because SES checks the action against every identity
   * involved - in the sandbox that includes the verified recipient address.
   * The conditions are what pin it down: this sender, this recipient only.
   */
  statement {
    sid       = "SendToTheOwnerOnly"
    actions   = ["ses:SendEmail"]
    resources = ["arn:${local.partition}:ses:${var.aws_region}:${local.account_id}:identity/*"]

    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [local.contact_from]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "ses:Recipients"
      values   = [var.contact_recipient_email]
    }
  }

  # Claim a slot, and give it back when sending fails. Nothing else.
  statement {
    sid       = "UseTheLimitTable"
    actions   = ["dynamodb:PutItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.contact_limits.arn]
  }

  statement {
    sid       = "ReadTheTurnstileSecret"
    actions   = ["ssm:GetParameter"]
    resources = [local.turnstile_parameter_arn]
  }

  /*
   * Decrypting it. key/* because the parameter may use the account's
   * aws/ssm key or a customer key, and this stack does not look either up;
   * the encryption context limits the grant to this one parameter, via SSM.
   */
  statement {
    sid       = "DecryptTheTurnstileSecret"
    actions   = ["kms:Decrypt"]
    resources = ["arn:${local.partition}:kms:${var.aws_region}:${local.account_id}:key/*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.aws_region}.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:PARAMETER_ARN"
      values   = [local.turnstile_parameter_arn]
    }
  }

  # The group is created below, so the function never needs CreateLogGroup.
  statement {
    sid       = "WriteOwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.contact.arn}:*"]
  }
}

resource "aws_iam_role_policy" "contact" {
  name   = local.contact_name
  role   = aws_iam_role.contact.id
  policy = data.aws_iam_policy_document.contact.json
}

/*
 * Logs hold outcomes and request IDs, never message content (the handler
 * guarantees it). Encrypted with the CloudWatch-owned key: a customer key
 * would cost more per month than this whole stack, for logs that hold
 * nothing sensitive.
 */
#trivy:ignore:AVD-AWS-0017
resource "aws_cloudwatch_log_group" "contact" {
  name              = "/aws/lambda/${local.contact_name}"
  retention_in_days = var.log_retention_days
}

/*
 * No X-Ray tracing: one function, one downstream call per request, and the
 * outcome logs already say which step failed.
 */
#trivy:ignore:AVD-AWS-0066
resource "aws_lambda_function" "contact" {
  function_name = local.contact_name
  description   = "Contact form: validate, verify Turnstile, send via SES."
  role          = aws_iam_role.contact.arn

  # Built by `npm run build --workspace api/contact`, reproducibly, so the
  # hash moves only when the handler does. CI builds it before planning and
  # ships it with the saved plan (scripts/ci/terraform-plan.sh).
  filename      = local.contact_bundle
  code_sha256   = filebase64sha256(local.contact_bundle)
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  handler       = "index.handler"
  memory_size   = 256
  timeout       = 10

  # -1 removes the reservation; see the variable for why that may be needed.
  reserved_concurrent_executions = var.contact_reserved_concurrency

  environment {
    variables = {
      MAIL_TRANSPORT             = "ses"
      MAIL_FROM                  = local.contact_from
      MAIL_TO                    = var.contact_recipient_email
      TURNSTILE_SECRET_PARAMETER = local.turnstile_parameter_name
      TURNSTILE_HOSTNAME         = local.domain_enabled ? var.domain_name : ""
      ORIGIN_VERIFY_SECRET       = random_password.origin_verify.result
      RATE_LIMIT_TABLE           = aws_dynamodb_table.contact_limits.name
      RATE_LIMIT_WINDOW_SECONDS  = tostring(var.contact_rate_limit_window_seconds)
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.contact.name
  }

  depends_on = [aws_iam_role_policy.contact]
}

# --- API Gateway -------------------------------------------------------------

resource "aws_apigatewayv2_api" "contact" {
  name          = local.contact_name
  description   = "Contact form API, reached through CloudFront at /api/*."
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "contact" {
  api_id                 = aws_apigatewayv2_api.contact.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.contact.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 12000
}

# The only route. Anything else is API Gateway's own 404, never the Lambda.
resource "aws_apigatewayv2_route" "contact" {
  api_id    = aws_apigatewayv2_api.contact.id
  route_key = "POST /api/contact"
  target    = "integrations/${aws_apigatewayv2_integration.contact.id}"
}

# Same reasoning as the function's log group above.
#trivy:ignore:AVD-AWS-0017
resource "aws_cloudwatch_log_group" "contact_api" {
  name              = "/aws/apigateway/${local.contact_name}"
  retention_in_days = var.log_retention_days
}

/*
 * Throttling applies to every route on the stage: requests over the rate
 * get a 429 from API Gateway without reaching Lambda.
 *
 * The access log records request metadata only - no body, no source IP
 * (behind CloudFront it would be an edge server anyway).
 */
resource "aws_apigatewayv2_stage" "contact" {
  api_id      = aws_apigatewayv2_api.contact.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_rate_limit  = var.contact_throttle_rate_limit
    throttling_burst_limit = var.contact_throttle_burst_limit
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.contact_api.arn
    format = jsonencode({
      requestId          = "$context.requestId"
      requestTime        = "$context.requestTime"
      routeKey           = "$context.routeKey"
      status             = "$context.status"
      responseLatency    = "$context.responseLatency"
      integrationStatus  = "$context.integrationStatus"
      integrationLatency = "$context.integrationLatency"
      errorMessage       = "$context.error.message"
    })
  }
}

resource "aws_lambda_permission" "contact" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.contact.function_name
  principal     = "apigateway.amazonaws.com"
  # Only this API's one route, on any stage.
  source_arn = "${aws_apigatewayv2_api.contact.execution_arn}/*/POST/api/contact"
}
