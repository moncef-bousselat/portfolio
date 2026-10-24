/*
 * Nothing environment-specific has a default here. The repo is public, so
 * account-shaped values arrive through terraform.tfvars (git-ignored) or,
 * in CI, through repository variables. terraform.tfvars.example shows the
 * shape.
 */

variable "aws_region" {
  description = "Region for the site bucket and everything regional in this stack."
  type        = string
}

variable "project" {
  description = "Short slug used to name and tag everything this stack creates. Match infra/bootstrap."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]{3,24}$", var.project))
    error_message = "project must be 3-24 characters of lowercase letters, digits or hyphens."
  }
}

/*
 * The ci-deploy role in infra/bootstrap names this bucket in its policy, and
 * the two stacks are in separate states, so nothing checks they agree except
 * a deploy failing with AccessDenied. Copy the value from bootstrap's
 * terraform.tfvars rather than retyping it.
 */
variable "site_bucket_name" {
  description = "Globally unique name for the static site bucket. Must equal site_bucket_name in infra/bootstrap."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.site_bucket_name))
    error_message = "site_bucket_name must be a valid S3 bucket name (3-63 chars, lowercase)."
  }
}

variable "tags" {
  description = "Extra tags merged into the defaults applied to every resource."
  type        = map(string)
  default     = {}
}

variable "price_class" {
  description = <<-DESC
    Which edge locations serve the site. PriceClass_100 (North America and
    Europe) is the cheapest; a visitor elsewhere is served from the nearest
    of those instead, a little slower. PriceClass_All serves from everywhere.
  DESC
  type        = string
  default     = "PriceClass_100"

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.price_class)
    error_message = "price_class must be PriceClass_100, PriceClass_200 or PriceClass_All."
  }
}

# --- Domain (optional) -----------------------------------------------------

variable "domain_name" {
  description = <<-DESC
    Apex domain the site is served at, e.g. example.com. null serves it at
    the distribution's *.cloudfront.net address with CloudFront's default
    certificate, and creates no ACM or Route 53 resources.

    Must match `site` in site/astro.config.mjs, which writes this domain into
    every canonical URL, hreflang link and RSS entry.
  DESC
  type        = string
  default     = null

  validation {
    condition     = var.domain_name == null || can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", var.domain_name))
    error_message = "domain_name must be a lowercase apex domain such as example.com, or null."
  }
}

variable "create_hosted_zone" {
  description = <<-DESC
    true creates a Route 53 hosted zone for domain_name; false adopts the one
    that already exists. A domain registered through Route 53 already has one
    (the registrar created it), so this is false for that case.

    With true and a registrar outside Route 53, the zone's name servers must
    be set at the registrar before the certificate can validate - see the
    two-step apply in terraform.tfvars.example.
  DESC
  type        = bool
  default     = false
}

variable "enable_www_redirect" {
  description = "Also serve www.<domain_name>, which the viewer-request function 301s to the apex."
  type        = bool
  default     = true
}

# --- Cost guardrail --------------------------------------------------------

variable "budget_limit_usd" {
  description = "Monthly cost budget for the whole account, in USD. Alerts fire at 80% actual and 100% forecast."
  type        = number

  validation {
    condition     = var.budget_limit_usd > 0
    error_message = "budget_limit_usd must be positive."
  }
}

# Not committed anywhere: the repo is public. terraform.tfvars locally, the
# MAIN_TFVARS secret in CI. Sensitive, so plan and apply output redact it.
variable "budget_alert_email" {
  description = "Address the budget alerts are sent to."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.budget_alert_email))
    error_message = "budget_alert_email must be an email address."
  }
}

# --- Contact form ----------------------------------------------------------

# Like budget_alert_email: terraform.tfvars locally, MAIN_TFVARS in CI, and
# redacted from plan output. It ends up in the Lambda's environment.
variable "contact_recipient_email" {
  description = "The one address contact form submissions are sent to. Never a visitor's."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.contact_recipient_email))
    error_message = "contact_recipient_email must be an email address."
  }
}

variable "ses_from_email" {
  description = <<-DESC
    Sender of the contact emails. null means contact@<domain_name>, and the
    whole domain is verified in SES through DKIM records in its zone. An
    address on another domain is verified on its own instead (SES emails it
    a link). Required when domain_name is null.
  DESC
  type        = string
  default     = null

  validation {
    condition     = var.ses_from_email != null || var.domain_name != null
    error_message = "Set ses_from_email: without domain_name there is no contact@<domain> to default to."
  }

  validation {
    condition     = var.ses_from_email == null || can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.ses_from_email))
    error_message = "ses_from_email must be an email address or null."
  }
}

variable "turnstile_secret_parameter_name" {
  description = <<-DESC
    Name of the SSM SecureString holding the Turnstile secret key, created by
    hand (docs in terraform.tfvars.example). null means /<project>/turnstile-secret.
    Only the name is used - the value never enters Terraform state.
  DESC
  type        = string
  default     = null

  validation {
    condition     = var.turnstile_secret_parameter_name == null || startswith(coalesce(var.turnstile_secret_parameter_name, "/"), "/")
    error_message = "turnstile_secret_parameter_name must be a path starting with /."
  }
}

variable "contact_throttle_rate_limit" {
  description = "Steady-state requests per second the contact API accepts, across all visitors."
  type        = number
  default     = 1

  validation {
    condition     = var.contact_throttle_rate_limit > 0
    error_message = "contact_throttle_rate_limit must be positive."
  }
}

variable "contact_throttle_burst_limit" {
  description = "Requests the contact API accepts in a burst above the steady rate."
  type        = number
  default     = 5

  validation {
    condition     = var.contact_throttle_burst_limit >= 1 && floor(var.contact_throttle_burst_limit) == var.contact_throttle_burst_limit
    error_message = "contact_throttle_burst_limit must be a whole number, at least 1."
  }
}

variable "contact_rate_limit_window_seconds" {
  description = "One message per visitor (IP, or IPv6 /64) per this many seconds. 0 turns the limit off."
  type        = number
  default     = 300

  validation {
    condition     = var.contact_rate_limit_window_seconds == 0 || (var.contact_rate_limit_window_seconds >= 60 && var.contact_rate_limit_window_seconds <= 86400 && floor(var.contact_rate_limit_window_seconds) == var.contact_rate_limit_window_seconds)
    error_message = "contact_rate_limit_window_seconds must be 0, or a whole number of seconds from 60 to 86400."
  }
}

/*
 * Reserving concurrency is refused when it would leave the account fewer
 * than 10 unreserved executions - which is every account still on the
 * default quota of 10 (check: aws lambda get-account-settings). -1 removes
 * the reservation; stage throttling then remains the cap.
 */
variable "contact_reserved_concurrency" {
  description = "Reserved concurrency for the contact Lambda, which is also its ceiling. -1 for none."
  type        = number
  default     = 2

  validation {
    condition     = var.contact_reserved_concurrency == -1 || var.contact_reserved_concurrency >= 1
    error_message = "contact_reserved_concurrency must be -1 (no reservation) or at least 1."
  }
}

variable "log_retention_days" {
  description = "Retention of the contact Lambda and API logs."
  type        = number
  default     = 14

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365], var.log_retention_days)
    error_message = "log_retention_days must be a value CloudWatch Logs accepts, up to 365."
  }
}
