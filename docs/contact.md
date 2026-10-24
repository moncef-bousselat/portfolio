# Contact form

The form on `/contact/` posts JSON to `/api/contact`. CloudFront routes that
path to an API Gateway HTTP API, which invokes the `portfolio-contact` Lambda
([`api/contact/`](../api/contact)). The Lambda validates the message, checks
the Cloudflare Turnstile token and sends the email through SES.
[`infra/main/contact.tf`](../infra/main/contact.tf) defines all of it except
the Turnstile secret, which is the one value that never goes through
Terraform.

```mermaid
flowchart LR
  browser["Browser<br/>form + Turnstile widget"]
  cf["CloudFront<br/>/api/*, no cache"]
  api["API Gateway<br/>POST /api/contact, throttled"]
  fn["Lambda<br/>validate, verify, send"]
  ts["Cloudflare<br/>siteverify"]
  ssm["SSM<br/>Turnstile secret"]
  ddb["DynamoDB<br/>per-visitor limit"]
  ses["SES<br/>DKIM-signed"]
  inbox["Your inbox"]

  browser --> cf -- "+ x-origin-verify" --> api --> fn
  fn --> ts
  fn --> ssm
  fn --> ddb
  fn --> ses --> inbox
```

## The Turnstile secret is not in the infrastructure code

Terraform writes every value it manages into its state file in plain text,
`SecureString` parameters included. If Terraform created the secret, anyone
who can read the state bucket could read the secret too, and so could every
plan job that loads that state. So the parameter is created by hand, once,
outside Terraform:

- **Terraform knows only its name** (`turnstile_secret_parameter_name`,
  default `/portfolio/turnstile-secret`). It passes the name to the Lambda and
  grants the Lambda role `ssm:GetParameter` on that parameter, plus
  `kms:Decrypt` scoped to it.
- **The Lambda reads the value at runtime**, on every request that reaches
  the Turnstile check, with no cache
  ([`secret.ts`](../api/contact/src/secret.ts)).
- **It is in no file, no tfvars, no GitHub secret and no log.**

The **site key** is a different matter. It is public by design, since it is
written into the page's HTML. It lives in the `PUBLIC_TURNSTILE_SITE_KEY`
repository variable, and the release build fails without it rather than
shipping Cloudflare's test key.

## What a message goes through

In order, cheapest first; each step stops the request before the next one
costs anything:

| Step                                       | Refuses with             | Where                  |
| ------------------------------------------ | ------------------------ | ---------------------- |
| Overall throttle: 1 request/s, bursts of 5 | 429                      | API Gateway stage      |
| Not from CloudFront (no `x-origin-verify`) | 403                      | Lambda                 |
| Malformed request, invalid field           | 400, 413, 415            | Lambda                 |
| Honeypot filled, or sent in under 3 s      | a fake 200, nothing sent | Lambda                 |
| Turnstile token rejected                   | 403                      | Lambda, via Cloudflare |
| Same visitor within 5 minutes              | 429, with `Retry-After`  | Lambda, via DynamoDB   |

**Why the origin check.** The API Gateway URL also answers directly, without
CloudFront in front. The visitor's IP comes from the `CloudFront-Viewer-Address`
header, which CloudFront sets, but a direct caller could set it to anything
and dodge the per-visitor limit. CloudFront therefore adds a random
`x-origin-verify` header to every request it forwards, and the Lambda refuses
any request without it.

**The per-visitor limit.** One message per IP address (IPv6: per /64, which
one connection usually holds whole) per `contact_rate_limit_window_seconds`,
300 by default, 0 to turn it off. The slot is taken only after Turnstile
passes, so nobody can block a shared IP without solving the challenge, and
it is given back if the email then fails to send. If DynamoDB fails, the
message goes through and the log says `limitUnavailable`: the limit is a
second line behind Turnstile.

The table never holds an IP. Its key is an HMAC of the IP under a key derived
from the Turnstile secret, so the hashes cannot be reversed by trying every
IPv4 address, and rotating the secret resets every limit. Items expire
through DynamoDB TTL, which deletes them lazily, so the Lambda compares the
expiry time itself.

## Setup

Done once, before the first apply that creates the contact stack.

**1. Turnstile widget.** Create a free Cloudflare account, then go to
Turnstile → Add widget:

| Setting       | Value                            |
| ------------- | -------------------------------- |
| Name          | `portfolio contact`              |
| Hostname      | the site's domain, and only that |
| Widget mode   | Managed                          |
| Pre-clearance | No                               |

Cloudflare shows a site key and a secret key.

**2. The secret, into SSM.** `read -rs` keeps it off the screen, out of shell
history and out of any file:

```sh
read -rs TS_SECRET && aws ssm put-parameter --region <aws_region> \
  --name /portfolio/turnstile-secret --type SecureString \
  --value "$TS_SECRET" && unset TS_SECRET
```

Paste the secret key at the silent prompt and press Enter.

**3. The site key, into GitHub.**

```sh
gh variable set PUBLIC_TURNSTILE_SITE_KEY --body '<site key>'
```

**4. The recipient.** Add `contact_recipient_email` to
`infra/main/terraform.tfvars` (git-ignored), then upload the file again:

```sh
gh secret set MAIN_TFVARS < infra/main/terraform.tfvars
```

The sender defaults to `contact@<domain>`. Terraform verifies the domain in
SES and creates its three DKIM records in Route 53, so the sender needs no
setup. Nothing receives mail at that address; replies go to the visitor
through `Reply-To`.

**5. SES sandbox.** A new SES account can only send to verified addresses.
Check, and if it prints `false`, verify the recipient and click the link in
the email that arrives:

```sh
aws sesv2 get-account --region <aws_region> --query ProductionAccessEnabled
aws sesv2 create-email-identity --region <aws_region> --email-identity '<recipient>'
```

## Rotating the Turnstile secret

Rotate if the secret may have leaked, and otherwise whenever you like. Nothing
is redeployed, and the site key does not change.

1. In Cloudflare, open the widget → Settings → **Rotate Secret Key**. For the
   next two hours both the old and the new secret are accepted.
2. Within those two hours, overwrite the parameter:

   ```sh
   read -rs TS_SECRET && aws ssm put-parameter --region <aws_region> \
     --name /portfolio/turnstile-secret --type SecureString --overwrite \
     --value "$TS_SECRET" && unset TS_SECRET
   ```

3. The next request already uses the new secret: the Lambda reads the
   parameter on every request, so nothing needs restarting.
4. Send a test message from the live form and check that it arrives:

   ```sh
   aws logs tail /aws/lambda/portfolio-contact --region <aws_region> --since 10m
   ```

If the form reports that the spam check failed after the two hours, the
parameter probably still holds the old secret. Check when it last changed,
without printing it:

```sh
aws ssm get-parameter --region <aws_region> --name /portfolio/turnstile-secret \
  --query Parameter.LastModifiedDate
```

## Rotating the origin secret

The `x-origin-verify` value is generated by Terraform (`random_password`), so
unlike the Turnstile secret it is in state and in the CloudFront and Lambda
configuration. Leaked, it only lets a caller skip CloudFront and pose as other
IPs; Turnstile and the throttle still apply. To replace it:

```sh
cd infra/main
terraform plan -replace=random_password.origin_verify -out=tfplan
terraform apply tfplan
```

The Lambda switches at once and CloudFront within a few minutes, so for those
minutes real messages get a 403. Rotate at a quiet time.

## Locally

No Cloudflare account or AWS access is needed. `npm run dev` uses Cloudflare's
test keys, which always pass, and prints the email instead of sending it.
[`api/contact/.env.example`](../api/contact/.env.example) lists the test
secrets that always fail, to see the error paths.

There is no CloudFront locally, so no origin check, and the per-visitor limit
is held in memory with a 60-second window. Every local request comes from
`127.0.0.1`, so a second message within a minute shows the limit's message.
