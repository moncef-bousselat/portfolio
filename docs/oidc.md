# GitHub Actions → AWS, without stored credentials

CI deploys this site and applies its infrastructure without a single AWS
secret in GitHub. This explains how, and how to set it up from nothing.

Everything described here lives in [`infra/bootstrap/`](../infra/bootstrap),
which is applied **only from a workstation**, never by CI.

## Why not an access key

The usual approach is an IAM user with a static access key pasted into GitHub
Secrets. That key is long-lived, works from anywhere, and on a public
repository a single careless `echo` publishes it to a world-readable log.
Rotation is the only remedy, and it is manual.

OpenID Connect replaces it with a token GitHub mints per job, which expires in
minutes and never exists outside the runner.

## The flow

1. A job declares `permissions: id-token: write`.
2. It asks GitHub's token service for a JWT. GitHub signs it, scoped to that
   one job.
3. It calls `sts:AssumeRoleWithWebIdentity` with that JWT and a role ARN.
4. AWS fetches GitHub's public keys from the issuer's JWKS endpoint, verifies
   the signature, and compares the token's claims against the role's trust
   policy.
5. On a match, STS returns temporary credentials.

No secret ever travels between GitHub and AWS. The trust relationship is
configured once, in IAM.

## The claims that decide access

| Claim | Value                                         | Enforced by                                                          |
| ----- | --------------------------------------------- | -------------------------------------------------------------------- |
| `iss` | `https://token.actions.githubusercontent.com` | the `Principal` — the OIDC provider's ARN                            |
| `aud` | `sts.amazonaws.com`                           | a `StringEquals` condition on every role                             |
| `sub` | see below                                     | a `StringEquals` condition — this is the real authorization decision |

`aud` defaults to the repository owner's URL;
`aws-actions/configure-aws-credentials` overrides it to `sts.amazonaws.com`.
Pinning it is not optional — without it, a token minted for a different
service could be replayed against STS.

### The subject format, and the trap in it

`sub` describes _what kind of run_ produced the token:

| Run                      | Subject                   |
| ------------------------ | ------------------------- |
| push to a branch         | `…:ref:refs/heads/BRANCH` |
| pull request             | `…:pull_request`          |
| job using an environment | `…:environment:NAME`      |

**A job that declares an `environment:` gets the environment subject and not
the branch one**, even when it runs on `main`. A trust policy keyed on
`ref:refs/heads/main` therefore rejects exactly the deployment job it was
written for. This is the single most common first-run failure.

**Repositories created after 2026-07-15 use an immutable subject format** that
embeds numeric IDs:

```
repo:OWNER@OWNER-ID/REPO@REPO-ID:environment:production     # new
repo:OWNER/REPO:environment:production                      # older repos
```

Most tutorials online still show the old form. Using the wrong one produces a
policy that never matches, and the resulting denial does not say why. The
`use_immutable_subject` variable picks between them; `oidc-check.yml` prints
the subject GitHub actually minted so you can compare rather than guess.

The ID form is also strictly better: it survives renaming the repository or
the account, and cannot be hijacked by recreating a deleted repository under
the same name.

## The three roles

| Role                | Accepts                                 | Can do                                                              |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------- |
| `PROJECT-ci-plan`   | `:pull_request`, `:ref:refs/heads/main` | read everything, hold the state lock, upload plans. Mutates nothing |
| `PROJECT-ci-apply`  | `:environment:infra` only               | apply `infra/main`                                                  |
| `PROJECT-ci-deploy` | `:environment:production` only          | sync the site bucket, invalidate CloudFront                         |

Three deliberate properties:

- **The plan role cannot change anything.** It is reachable from any pull
  request, so it is the one an attacker would reach first.
- **The apply role cannot edit the roles.** An explicit `Deny` covers all
  three role ARNs and the OIDC provider. Explicit denies cannot be overridden
  by any allow, so CI cannot widen its own permissions even with `iam:*`
  granted elsewhere in its policy. Changing them requires a local apply.
- **The apply role cannot rewrite the bootstrap state**, which is denied by
  key prefix, so the record of CI's own permissions is outside CI's reach.

The plan role carries the AWS-managed `ReadOnlyAccess`. That is broad in what
it can _see_, chosen deliberately: `terraform plan` must refresh every
resource in state, and a hand-written list breaks the first time a new
resource type appears, as a confusing `AccessDenied` in CI. It cannot mutate
anything, which is the property that matters for a role reachable from a PR.

The apply role is the opposite: it can change only the services listed in
`infra/bootstrap/roles.tf`. **A resource of a new service in `infra/main`
needs that list extended and bootstrap applied locally first.** The PR's plan
passes regardless (the plan role reads everything), so the gap only shows at
apply, as an `AccessDenied` halfway through. That happened with the contact
form's DynamoDB table.

Plans travel through the state bucket under `plans/`, not as GitHub artifacts
— on a public repository those are world-downloadable, and a plan can contain
sensitive values.

## GitHub environments

A GitHub _environment_ has nothing to do with git. It is a named deployment
target in **Settings → Environments** that gives you three things: protection
rules, scoped secrets, and deployment history. A job opts in with one line:

```yaml
jobs:
  deploy:
    environment: production
```

It is used here for two reasons. It is the gate — protection rules decide
whether the job may start at all. And it changes the `sub` claim, which is
what lets the AWS trust policy accept _only_ jobs that went through it. A
workflow that omits the `environment:` line gets a different subject and AWS
refuses it, so the gate cannot be skipped by forgetting it.

Two layers, deliberately:

| Layer                        | Enforced by | Says                                                |
| ---------------------------- | ----------- | --------------------------------------------------- |
| deployment branch rule       | GitHub      | only `main` may deploy to this environment          |
| trust policy `sub` condition | AWS         | only a job in this environment may assume this role |

GitHub's rule can be changed by any repository admin. The AWS one cannot be
changed from CI at all.

## Runbook — first apply

Prerequisites: the toolchain in `.tool-versions` (`asdf install`), and AWS
credentials for a principal that can create S3 buckets and IAM roles.

**1. Read the GitHub IDs.**

```sh
gh api repos/OWNER/REPO --jq '{repo_id: .id, owner_id: .owner.id}'
```

**2. Fill in the variables.**

```sh
cd infra/bootstrap
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars        # git-ignored
```

**3. Check it locally.** None of these touch AWS:

> `terraform fmt` formats `.tfvars` too, so it will flag your own
> `terraform.tfvars` once you edit it — the file is git-ignored but not
> fmt-ignored. Run `terraform fmt infra/bootstrap/terraform.tfvars` to tidy
> it; the change is alignment only.

```sh
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
cd .. && tflint --init && tflint --recursive && cd bootstrap
cd ../.. && trivy config --exit-code 1 infra/
```

**4. Apply on local state.** The backend block in `versions.tf` points at the
state bucket this apply creates, so for a first apply into a fresh account,
comment it out first. Step 6 moves the state in afterwards.

```sh
cd infra/bootstrap
terraform init
terraform plan -out=tfplan      # read it
terraform apply tfplan
```

**5. Record the outputs.**

```sh
terraform output role_arns
terraform output state_bucket
terraform output accepted_subjects
```

**6. Move the state into S3.** Restore the backend block, then:

```sh
terraform init -migrate-state \
  -backend-config="bucket=YOUR-STATE-BUCKET" \
  -backend-config="region=YOUR-REGION"
```

Until this is done, the only copy is `terraform.tfstate` in that directory,
and it is git-ignored. Losing it orphans the roles and the OIDC provider — they
keep working, but Terraform no longer knows about them and you would have to
`terraform import` them back.

State locking is handled by S3 itself via `use_lockfile`. There is no
DynamoDB table; that mechanism is deprecated in the S3 backend.

## Runbook — GitHub setup

**Environments** (Settings → Environments), two of them:

| Environment  | Deployment branches | Required reviewers                         |
| ------------ | ------------------- | ------------------------------------------ |
| `production` | `main` only         | none — merging a content PR should publish |
| `infra`      | `main` only         | yourself                                   |

On `infra`, leave **Prevent self-review off**. On a solo repository you are
both the person who triggers the run and the only reviewer; with it on, the
job waits forever.

**Repository secrets and variables** (Settings → Secrets and variables →
Actions):

| Name              | Kind       | Value                              |
| ----------------- | ---------- | ---------------------------------- |
| `AWS_REGION`      | Variable   | the region from `terraform.tfvars` |
| `AWS_ROLE_PLAN`   | **Secret** | `role_arns.plan`                   |
| `AWS_ROLE_APPLY`  | **Secret** | `role_arns.apply`                  |
| `AWS_ROLE_DEPLOY` | **Secret** | `role_arns.deploy`                 |

The role ARNs are **secrets, not variables**, because a role ARN contains the
AWS account ID and this repository is public — which makes its workflow logs
public too. Variables are plaintext in logs; secrets are masked.

An AWS account ID is not a credential, and AWS's own position is that it is
not secret. But it identifies the account to anyone enumerating targets, and
there is nothing to gain here by publishing it.

Masking the secret is not sufficient on its own. GitHub masks the exact
stored string, while `sts:GetCallerIdentity` returns an _assumed-role_ ARN —
a different string carrying the same account ID. So every
`configure-aws-credentials` step also sets `mask-aws-account-id: true`, which
registers the ID itself as a mask for the rest of the job. The action does
not do that by default.

## Runbook — prove it

> **The workflow must be on the default branch first.** A `workflow_dispatch`
> workflow only triggers, and only shows a "Run workflow" button, if the file
> exists on `main` — so merge the PR that adds it before trying to run it.
> Selecting a different branch in the dialog afterwards is fine; the
> requirement is only that the file is also on `main`. The secrets, variables
> and environments are repository-level and can be set up beforehand.

Run **OIDC check** from the Actions tab. Six jobs:

- `subject` prints the real token claims
- `plan-role` assumes the plan role — must pass
- `apply-role-denied` / `deploy-role-denied` attempt the gated roles with no
  environment — **must fail**
- `apply-role` / `deploy-role` do the same inside their environments — must
  pass

The two `*-denied` jobs are the point. A green run where those pass means the
trust policies are too broad.

The `apply-role` job will pause for your approval. That is the gate working.

## Troubleshooting

| Symptom                                                   | Cause                                                                                                                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | The `sub` does not match. Compare `subject` job output against `terraform output accepted_subjects`. Usually the immutable-format question, or a job missing its `environment:` |
| …on the deploy job only                                   | The job declares an environment, so its subject is the environment form, not the branch form                                                                                    |
| `Could not load credentials from any providers`           | The job is missing `permissions: id-token: write`                                                                                                                               |
| `EntityAlreadyExists: …OpenIDConnectProvider`             | The account already has one. Set `create_oidc_provider = false` to adopt it                                                                                                     |
| `InvalidIdentityToken: Incorrect token audience`          | `aud` mismatch — the action's `audience` input was overridden                                                                                                                   |
| Job hangs on "Waiting for approval" forever               | **Prevent self-review** is on, and you are the only reviewer                                                                                                                    |
