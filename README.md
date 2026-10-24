# Portfolio

Personal portfolio site for a Cloud & DevOps engineer. Static, content-driven,
accessible, and cheap to run — self-hosted on AWS.

Content lives as Markdown and MDX in the repo. There is no CMS, no database and
no runtime content fetching: merging a pull request to `main` rebuilds and
redeploys the site.

## Stack

| Layer          | Choice                                                             |
| -------------- | ------------------------------------------------------------------ |
| Site           | [Astro](https://astro.build) 7, static output, content collections |
| Content        | Markdown / MDX with Zod-validated frontmatter                      |
| Styling        | Plain CSS with custom-property design tokens                       |
| Interactivity  | Small vanilla TypeScript islands, no framework runtime             |
| Contact form   | TypeScript Lambda on Node.js 24 behind API Gateway, SES            |
| Infrastructure | Terraform — S3, CloudFront, ACM, Route 53, API Gateway, Lambda     |
| CI/CD          | GitHub Actions with OIDC, no long-lived AWS credentials            |

## Requirements

- Node.js 24 (the version in `.tool-versions`)
- npm 11

Tool versions are pinned in `.tool-versions`. With [asdf](https://asdf-vm.com):

```sh
asdf install
```

## Getting started

```sh
npm install
npm run dev
```

This starts two processes: the Astro dev server at `http://localhost:4321`,
with hot reloading for components, styles and content, and the local contact
API on port 8787, which runs the real Lambda handler and restarts when it
changes. The dev server proxies `/api/*` to it, as CloudFront does in
production.

Locally the contact form uses Cloudflare's Turnstile test keys and prints the
email it would send instead of calling SES, so the whole form works with no
accounts and no keys. `api/contact/.env.example` and `site/.env.example` show
what can be overridden, such as the test keys that always fail.

No AWS credentials are needed for local development, and none are needed to run
any check in this list.

## Troubleshooting

### `Node.js v20.x is not supported by Astro` or `npm error code EBADENGINE`

The shell is running a different Node than the one `.tool-versions` pins.
Check it:

```sh
node -v          # must match .tool-versions
which node       # should be inside your version manager, not /usr/local/bin
```

If you use asdf, the shims directory must be **prepended** to `PATH` in a file
every shell reads — `~/.zshenv` for zsh, `~/.bashrc` for bash. Putting it only
in `~/.zshrc` covers interactive shells but not login or non-interactive ones,
so editor tasks and scripts silently fall back to whatever Node is on the
system `PATH`:

```sh
export ASDF_DATA_DIR="$HOME/.asdf"
export PATH="$ASDF_DATA_DIR/shims:$PATH"
```

`engine-strict` is deliberately on in `.npmrc`, so a wrong Node version fails
at `npm install` with the required and actual versions named, rather than
surfacing later as a confusing build error.

## Scripts

Run from the repository root.

| Command                  | Does                                  |
| ------------------------ | ------------------------------------- |
| `npm run dev`            | Dev server and local contact API      |
| `npm run dev:api`        | Local contact API alone               |
| `npm run build`          | Production build to `site/dist/`      |
| `npm run check`          | Type and Astro diagnostics            |
| `npm run lint`           | ESLint, including accessibility rules |
| `npm run format`         | Format with Prettier                  |
| `npm run format:check`   | Verify formatting                     |
| `npm test`               | Unit tests (all workspaces)           |
| `npm run headers`        | Regenerate `config/headers.json`      |
| `npm run preview`        | Serve the build as CloudFront would   |
| `npm run infra:check`    | Terraform fmt, validate, test, scans  |
| `npm run lint:workflows` | actionlint and zizmor on `.github/`   |
| `npm run test:e2e`       | Browser smoke tests on the build      |
| `npm run og`             | Re-render the link preview images     |

### Checking a production build

```sh
npm run build && npm run headers && npm run preview
```

`npm run preview` serves `site/dist/` at `http://localhost:4500` the way the
CDN will: through the same CloudFront Function file, with missing pages
answered by the 404 page, `/api/*` forwarded to the local contact API (start
it with `npm run dev:api`), and with the exact security headers, including the
Content-Security-Policy, that CloudFront sends. A CSP violation therefore
shows up in the browser console here, before a deploy.

The CSP allows inline `<style>` blocks by hash, and only the font loader emits
those, so content never changes the policy. Code highlighting uses classes
(`site/src/styles/shiki.css`) rather than inline `style=""` attributes, which
the CSP does not allow and header generation rejects. The font files are
committed (`site/src/assets/fonts/`), so the build makes no network call and
the hashes change only when the font files or their configuration do:
`npm run headers` regenerates them, and CI's `npm run headers:check` fails if
the committed file is stale.

`npm run test:e2e` runs Playwright smoke tests against that same preview
server (it starts one if none is running): both home pages, the timeline,
a project opening from a deep link, the French fallback notice, contact
validation, the link preview tags, the sitemap. Every request to another
host is blocked, so the result never depends on a third party, and any
console error or CSP violation fails the test. The first run needs a
browser: `npx playwright install chromium`.

`npm run infra:check` needs Terraform, tflint and trivy (all in
`.tool-versions`). It reads no state and calls no AWS API. It builds the
contact Lambda's zip first, since Terraform hashes it.

## Deployment

Merging a pull request into `main` publishes the site. Every PR runs the
checks above plus a read-only Terraform plan; the merge rebuilds, applies any
infrastructure change after an explicit approval, and deploys. No AWS access
keys exist: GitHub Actions authenticates through OIDC into three narrowly
scoped roles. [`docs/ci.md`](docs/ci.md) has the pipeline, rollback and setup;
[`docs/oidc.md`](docs/oidc.md) the roles;
[`docs/contact.md`](docs/contact.md) the contact form's setup and how to
rotate its Turnstile secret.

A cost kill switch takes the site offline if CloudFront's estimated bill
crosses a threshold, and emails the owner; reopening is a manual, approved
workflow. [`docs/kill-switch.md`](docs/kill-switch.md) has how it estimates
cost, how to test it, and how to reopen.

## Layout

```
site/            Astro app and all content
api/contact/     Contact form Lambda
infra/           Terraform (bootstrap applied locally, main applied by CI)
config/          Security header and CSP definitions, shared by preview and CDN
scripts/         Local preview server and build tooling
docs/            Infrastructure and pipeline notes
```

## Analytics

Off by default: `analytics` in `site/src/config/site.ts` is `{ provider: 'none' }`,
and no script ships. CloudFront's console reports cover traffic meanwhile.

To use [Umami](https://umami.is) (cookieless), set the provider, script,
endpoint and website ID there, then `npm run build && npm run headers`. The
CSP gains the script's origin in `script-src` and the endpoint's in
`connect-src`; Umami Cloud's are different hosts, `cloud.umami.is` and
`gateway.umami.is`. Only the production hostname is counted, so local
builds never reach the dashboard. Two events are counted beyond pageviews:
`cv_download` and `contact_success`.

## Accessibility and performance

Accessibility is a build-time concern rather than an afterthought:
accessibility rules run in ESLint, images require alt text in their content
schemas, and all core content is readable with JavaScript disabled. The contact form is the
one exception, since its spam check is a script; with JavaScript off it stays
disabled and says why.

The colour palette is verified against WCAG AA contrast ratios, and every
animation respects `prefers-reduced-motion`.

## Licence

Source code is available for reference. Site content, written material and
imagery are not licensed for reuse.
