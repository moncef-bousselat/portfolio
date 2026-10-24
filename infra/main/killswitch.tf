/*
 * The cost kill switch:
 *
 *   CloudFront metrics -> two cost alarms -> SNS -> Lambda -> distribution off
 *                                                       \-> SNS -> owner email
 *
 * AWS has no hard spending cap, and a budget alert works from billing data
 * hours behind. These alarms estimate the CloudFront bill from the
 * distribution's own per-minute traffic instead:
 *
 *   cost = requests * request price / 10,000 + bytes out / 10^9 * GB price
 *
 * at the dearest pay-as-you-go rates the price class can hit, ignoring the
 * monthly free allowance: an overestimate, so the switch trips early rather
 * than late. Two windows: a fast one for a flood, a daily one for a slow
 * burn. Either going into ALARM disables the distribution and emails the
 * owner (api/contact/src/killswitch.ts).
 *
 * Nothing here turns the site back on. The distribution's `enabled` is
 * ignored after creation, so a later apply cannot quietly undo the switch;
 * the "Reopen site" workflow (.github/workflows/reopen-site.yml) re-arms the
 * alarms and re-enables it, behind the infra approval.
 *
 * All in us-east-1: CloudFront publishes its metrics there, and an alarm can
 * only notify a topic in its own region.
 */

locals {
  kill_switch_name = "${var.project}-kill-switch"
  site_host        = local.domain_enabled ? var.domain_name : aws_cloudfront_distribution.site.domain_name

  kill_switch_windows = var.kill_switch_enabled ? {
    "5min" = {
      period = 300
      usd    = var.kill_switch_fast_usd
      label  = "5 minutes"
    }
    "24h" = {
      period = 86400
      usd    = var.kill_switch_daily_usd
      label  = "24 hours"
    }
  } : {}
}

# --- Topics ------------------------------------------------------------------

/*
 * Unencrypted, both: they carry alarm states and a notice, nothing private.
 * Encrypting the alarm topic would need a customer key (CloudWatch cannot
 * use the aws/sns key), at more per month than the rest of this file.
 */

# CloudWatch -> the function.
#trivy:ignore:AVD-AWS-0095
resource "aws_sns_topic" "kill_switch" {
  count    = var.kill_switch_enabled ? 1 : 0
  provider = aws.us_east_1
  name     = local.kill_switch_name
}

# The function -> the owner. SNS emails a confirmation link once, on create.
#trivy:ignore:AVD-AWS-0095
resource "aws_sns_topic" "kill_switch_notify" {
  count    = var.kill_switch_enabled ? 1 : 0
  provider = aws.us_east_1
  name     = "${local.kill_switch_name}-notify"
}

resource "aws_sns_topic_subscription" "kill_switch_owner" {
  count     = var.kill_switch_enabled ? 1 : 0
  provider  = aws.us_east_1
  topic_arn = aws_sns_topic.kill_switch_notify[0].arn
  protocol  = "email"
  endpoint  = var.budget_alert_email
}

# --- Alarms ------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "kill_switch" {
  for_each = local.kill_switch_windows
  provider = aws.us_east_1

  alarm_name = "${local.kill_switch_name}-${each.key}"
  # format(), not "$${...}": in HCL, $${ is the escape for a literal ${.
  alarm_description = format("Estimated CloudFront cost of at least $%s in %s. Disables the distribution.", each.value.usd, each.value.label)

  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = each.value.usd
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  # No traffic means no datapoints, and no cost.
  treat_missing_data = "notBreaching"

  alarm_actions = [aws_sns_topic.kill_switch[0].arn]

  metric_query {
    id          = "cost"
    label       = "Estimated CloudFront cost (USD)"
    expression  = "FILL(requests, 0) * ${var.cloudfront_request_price_per_10k_usd} / 10000 + FILL(bytes, 0) / 1000000000 * ${var.cloudfront_transfer_price_per_gb_usd}"
    return_data = true
  }

  metric_query {
    id = "requests"
    metric {
      namespace   = "AWS/CloudFront"
      metric_name = "Requests"
      period      = each.value.period
      stat        = "Sum"
      dimensions = {
        DistributionId = aws_cloudfront_distribution.site.id
        Region         = "Global"
      }
    }
  }

  metric_query {
    id = "bytes"
    metric {
      namespace   = "AWS/CloudFront"
      metric_name = "BytesDownloaded"
      period      = each.value.period
      stat        = "Sum"
      dimensions = {
        DistributionId = aws_cloudfront_distribution.site.id
        Region         = "Global"
      }
    }
  }
}

# --- The function ------------------------------------------------------------

resource "aws_iam_role" "kill_switch" {
  count              = var.kill_switch_enabled ? 1 : 0
  name               = local.kill_switch_name
  assume_role_policy = data.aws_iam_policy_document.contact_assume.json
}

data "aws_iam_policy_document" "kill_switch" {
  count = var.kill_switch_enabled ? 1 : 0

  # Read and switch off this one distribution. Nothing else in CloudFront.
  statement {
    sid       = "DisableTheSite"
    actions   = ["cloudfront:GetDistributionConfig", "cloudfront:UpdateDistribution"]
    resources = [aws_cloudfront_distribution.site.arn]
  }

  statement {
    sid       = "NotifyTheOwner"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.kill_switch_notify[0].arn]
  }

  statement {
    sid       = "WriteOwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.kill_switch[0].arn}:*"]
  }
}

resource "aws_iam_role_policy" "kill_switch" {
  count  = var.kill_switch_enabled ? 1 : 0
  name   = local.kill_switch_name
  role   = aws_iam_role.kill_switch[0].id
  policy = data.aws_iam_policy_document.kill_switch[0].json
}

# As the contact function's: outcomes only, CloudWatch-owned key.
#trivy:ignore:AVD-AWS-0017
resource "aws_cloudwatch_log_group" "kill_switch" {
  count             = var.kill_switch_enabled ? 1 : 0
  provider          = aws.us_east_1
  name              = "/aws/lambda/${local.kill_switch_name}"
  retention_in_days = var.log_retention_days
}

/*
 * The contact zip: it holds both functions (api/contact/scripts/bundle.mjs).
 * No reserved concurrency: one alarm, one invocation, and reserving fails on
 * accounts still on Lambda's default quota of 10. No X-Ray: one call each.
 */
#trivy:ignore:AVD-AWS-0066
resource "aws_lambda_function" "kill_switch" {
  count         = var.kill_switch_enabled ? 1 : 0
  provider      = aws.us_east_1
  function_name = local.kill_switch_name
  description   = "Cost kill switch: disables the CloudFront distribution and emails the owner."
  role          = aws_iam_role.kill_switch[0].arn

  filename      = local.contact_bundle
  code_sha256   = filebase64sha256(local.contact_bundle)
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  handler       = "killswitch.handler"
  memory_size   = 128
  timeout       = 30

  environment {
    variables = {
      DISTRIBUTION_ID  = aws_cloudfront_distribution.site.id
      NOTIFY_TOPIC_ARN = aws_sns_topic.kill_switch_notify[0].arn
      SITE_NAME        = local.site_host
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.kill_switch[0].name
  }

  depends_on = [aws_iam_role_policy.kill_switch]
}

resource "aws_lambda_permission" "kill_switch" {
  count         = var.kill_switch_enabled ? 1 : 0
  provider      = aws.us_east_1
  statement_id  = "AllowKillSwitchTopic"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.kill_switch[0].function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.kill_switch[0].arn
}

resource "aws_sns_topic_subscription" "kill_switch_function" {
  count     = var.kill_switch_enabled ? 1 : 0
  provider  = aws.us_east_1
  topic_arn = aws_sns_topic.kill_switch[0].arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.kill_switch[0].arn

  depends_on = [aws_lambda_permission.kill_switch]
}
