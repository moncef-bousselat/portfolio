terraform {
  required_version = "~> 1.16"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.69"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
  }

  /*
   * State lives in the bucket infra/bootstrap created, under its own key.
   * The bucket name and region are not written here - the repo is public,
   * and they are account-specific - so they arrive at init time:
   *
   *   terraform init \
   *     -backend-config="bucket=<state bucket>" \
   *     -backend-config="region=<state bucket region>"
   *
   * The key must stay outside bootstrap/: the apply role is denied every
   * object under that prefix.
   */
  backend "s3" {
    key          = "main/terraform.tfstate"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.tags
  }
}

/*
 * CloudFront only accepts ACM certificates issued in us-east-1, whatever
 * region the rest of the stack is in. Used by domain.tf alone.
 */
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = local.tags
  }
}
