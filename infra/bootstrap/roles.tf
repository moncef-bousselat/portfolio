/*
 * The three CI roles.
 *
 * They live here, in bootstrap, rather than in infra/main, because bootstrap
 * is applied only from a laptop. CI has no path to edit the roles that define
 * what CI may do - the apply role is explicitly denied IAM access to all
 * three, and to the OIDC provider that lets them be assumed at all.
 *
 * The split is the point: a workflow that can read cannot change, and the two
 * roles that can change are reachable only from inside a GitHub environment.
 */

resource "aws_iam_role" "ci" {
  for_each = {
    plan = {
      description = "Terraform plan and credential-free checks. Read-only; runs on every PR."
    }
    apply = {
      description = "Terraform apply for infra/main. Gated by the ${var.infra_environment} environment."
    }
    deploy = {
      description = "Static site sync and CloudFront invalidation. Gated by the ${var.production_environment} environment."
    }
  }

  name               = "${var.project}-ci-${each.key}"
  description        = each.value.description
  assume_role_policy = data.aws_iam_policy_document.trust[each.key].json

  # An hour is the default and is far longer than any job here needs, but
  # shortening it buys nothing: the credentials die with the job either way.
  max_session_duration = 3600
}

# --- plan ------------------------------------------------------------------

/*
 * ReadOnlyAccess, deliberately, rather than a hand-written list.
 *
 * `terraform plan` has to refresh every resource in state, so a bespoke list
 * breaks the first time infra/main grows a resource type nobody predicted -
 * and the failure arrives as a confusing AccessDenied in CI. ReadOnlyAccess
 * is broad in what it can see but cannot mutate anything, which is the
 * property that actually matters for a role reachable from a PR.
 */
resource "aws_iam_role_policy_attachment" "plan_readonly" {
  role       = aws_iam_role.ci["plan"].name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/ReadOnlyAccess"
}

data "aws_iam_policy_document" "plan" {
  statement {
    sid       = "ReadState"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [local.state_bucket_arn]
  }

  statement {
    sid       = "GetStateObjects"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${local.state_bucket_arn}/*"]
  }

  /*
   * Write access narrowed to the lock file by suffix. Plan must take the
   * lock, but it must not be able to overwrite state - and "*.tflock" is
   * the difference between those two things.
   */
  statement {
    sid    = "HoldStateLock"
    effect = "Allow"

    actions = [
      "s3:PutObject",
      "s3:DeleteObject",
    ]

    resources = ["${local.state_bucket_arn}/*.tflock"]
  }

  /*
   * Plans travel through the state bucket rather than as GitHub artifacts,
   * which on a public repo are world-downloadable, and a plan can contain
   * sensitive values (docs/ci.md).
   */
  statement {
    sid       = "UploadPlans"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${local.state_bucket_arn}/plans/*"]
  }
}

resource "aws_iam_role_policy" "plan" {
  name   = "state-and-plans"
  role   = aws_iam_role.ci["plan"].id
  policy = data.aws_iam_policy_document.plan.json
}

# --- apply -----------------------------------------------------------------

data "aws_iam_policy_document" "apply" {
  statement {
    sid    = "ManageState"
    effect = "Allow"

    actions = [
      "s3:ListBucket",
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]

    resources = [
      local.state_bucket_arn,
      "${local.state_bucket_arn}/*",
    ]
  }

  /*
   * The services infra/main is made of. Scoped by service rather than by
   * resource: almost everything here is created by this role, so there is no
   * pre-existing ARN to name, and the guardrails that matter are the Deny
   * statements below.
   */
  statement {
    sid    = "ManageInfrastructure"
    effect = "Allow"

    actions = [
      "acm:*",
      "apigateway:*",
      "budgets:*",
      "cloudfront:*",
      "cloudwatch:*",
      "lambda:*",
      "logs:*",
      "route53:*",
      "route53domains:Get*",
      "route53domains:List*",
      "s3:*",
      "ses:*",
      "sns:*",
      "tag:Get*",
    ]

    resources = ["*"]
  }

  /*
   * DynamoDB, narrowed to tables named for this project (today the contact
   * form's per-visitor limit table). dynamodb:* rather than a list for the
   * same reason the plan role reads everything: the provider's refresh of a
   * table calls several Describe* actions that grow with its versions, and a
   * missing one surfaces as an AccessDenied halfway through an apply.
   */
  statement {
    sid       = "ManageProjectTables"
    effect    = "Allow"
    actions   = ["dynamodb:*"]
    resources = ["arn:${data.aws_partition.current.partition}:dynamodb:*:${data.aws_caller_identity.current.account_id}:table/${var.project}-*"]
  }

  # The Turnstile secret is created by hand and only read from here.
  statement {
    sid    = "ReadParameters"
    effect = "Allow"

    actions = [
      "ssm:DescribeParameters",
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:ListTagsForResource",
    ]

    resources = ["*"]
  }

  /*
   * IAM, narrowed to roles and policies this project names. infra/main needs
   * to create the Lambda execution role; it has no business touching
   * anything else in the account's IAM.
   */
  statement {
    sid    = "ManageProjectIAM"
    effect = "Allow"

    actions = [
      "iam:AttachRolePolicy",
      "iam:CreatePolicy",
      "iam:CreatePolicyVersion",
      "iam:CreateRole",
      "iam:CreateServiceLinkedRole",
      "iam:DeletePolicy",
      "iam:DeletePolicyVersion",
      "iam:DeleteRole",
      "iam:DeleteRolePolicy",
      "iam:DetachRolePolicy",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:ListEntitiesForPolicy",
      "iam:ListInstanceProfilesForRole",
      "iam:ListPolicyVersions",
      "iam:ListRolePolicies",
      "iam:PassRole",
      "iam:PutRolePolicy",
      "iam:TagPolicy",
      "iam:TagRole",
      "iam:UntagPolicy",
      "iam:UntagRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:UpdateRole",
      "iam:UpdateRoleDescription",
    ]

    resources = [
      "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${var.project}-*",
      "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:policy/${var.project}-*",
    ]
  }

  /*
   * Everything above is undone here for the handful of things that would let
   * CI widen its own reach. An explicit Deny cannot be overridden by any
   * Allow, in this policy or any other attached to the role.
   */

  statement {
    sid    = "DenyTouchingOwnPermissions"
    effect = "Deny"

    actions = ["iam:*"]

    resources = concat(
      [for r in aws_iam_role.ci : r.arn],
      [local.oidc_provider_arn],
    )
  }

  statement {
    sid    = "DenyIdentityCreation"
    effect = "Deny"

    actions = [
      "iam:AddUserToGroup",
      "iam:AttachUserPolicy",
      "iam:CreateAccessKey",
      "iam:CreateGroup",
      "iam:CreateLoginProfile",
      "iam:CreateOpenIDConnectProvider",
      "iam:CreateSAMLProvider",
      "iam:CreateUser",
      "iam:DeleteOpenIDConnectProvider",
      "iam:PutUserPolicy",
      "iam:UpdateAssumeRolePolicy",
      "iam:UpdateOpenIDConnectProviderThumbprint",
    ]

    resources = ["*"]
  }

  # The state describing CI's own permissions is not CI's to rewrite.
  statement {
    sid       = "DenyBootstrapState"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = ["${local.state_bucket_arn}/${local.bootstrap_state_key}"]
  }

  statement {
    sid       = "DenyDestroyingStateBucket"
    effect    = "Deny"
    actions   = ["s3:DeleteBucket", "s3:PutBucketPolicy", "s3:PutBucketVersioning"]
    resources = [local.state_bucket_arn]
  }
}

resource "aws_iam_role_policy" "apply" {
  name   = "terraform-apply"
  role   = aws_iam_role.ci["apply"].id
  policy = data.aws_iam_policy_document.apply.json
}

# --- deploy ----------------------------------------------------------------

/*
 * The narrowest of the three, and the one that runs most often. It publishes
 * files and invalidates the cache. It has no Terraform state access at all -
 * it learns the bucket name and distribution ID from GitHub repository
 * variables, not from state.
 */
data "aws_iam_policy_document" "deploy" {
  statement {
    sid    = "ListSiteBucket"
    effect = "Allow"

    actions = [
      "s3:ListBucket",
      "s3:GetBucketLocation",
    ]

    resources = [local.site_bucket_arn]
  }

  statement {
    sid    = "PublishSite"
    effect = "Allow"

    actions = [
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:PutObject",
    ]

    resources = ["${local.site_bucket_arn}/*"]
  }

  statement {
    sid    = "InvalidateCache"
    effect = "Allow"

    actions = [
      "cloudfront:CreateInvalidation",
      "cloudfront:GetInvalidation",
    ]

    resources = [var.cloudfront_distribution_arn]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "site-deploy"
  role   = aws_iam_role.ci["deploy"].id
  policy = data.aws_iam_policy_document.deploy.json
}
