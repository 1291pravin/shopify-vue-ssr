# shopify-vue-ssr

## 1. What it does

Render public Vue islands ahead of requests and cache their verified HTML in Shopify metaobjects. Liquid looks up each fragment using a key derived from the build, component and exact props. Browsers hydrate cache hits and client-render misses. A CLI crawls pages, renders misses locally and verifies hydration before storing HTML.

Keep visitor-specific sections, including cart, account and customer-specific pricing, client-only. Cache only public content whose complete inputs are represented in props. The request flow is described in [how it works](docs/how-it-works.md).

## 2. Requirements

- Node `^22.13.0 || >=24.0.0`. CI tests Node 22 and 24.
- Vite 8, Vue 3.5 and `@vitejs/plugin-vue` 6 in your existing theme project.
- A Shopify Online Store 2.0 theme, Admin access for setup and a deployment process.
- A committed npm lockfile and a build script that builds the SSR package outputs.
- Shopify CLI with `store auth` and `store execute` for local authentication, or the app credentials in section 7.

## 3. Install

Run in your existing Vite + Vue theme project, then commit the updated manifest and lockfile.

```sh
npm i -D github:1291pravin/shopify-vue-ssr
```

The repository ships native ESM, declarations and executable CLI source. Git installation needs no package compilation. The original, image-free demo in `example/` uses `"shopify-vue-ssr": "file:.."`. To validate it locally, run `npm ci` at the root, then `npm ci`, `npm run build` and `npx shopify-vue-ssr check` in `example/`.

## 4. Configure

Merge this into your existing `vite.config.ts`, preserving aliases, defines and other plugins.

```ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { shopifyVueSsr } from 'shopify-vue-ssr'

export default defineConfig({
  plugins: [
    vue(),
    shopifyVueSsr({
      islands: 'src/islands/**/*.vue',
      exclude: ['**/*.test.vue'],
      client: { entry: 'src/client.ts' },
      themeDir: 'theme',
      widths: [375, 1440],
      stores: {
        fr: {
          domain: 'example-fr.myshopify.com',
          sitemap: 'https://example-fr.myshopify.com/sitemap.xml',
        },
        de: {
          domain: 'example-de.myshopify.com',
          sitemap: 'https://example-de.myshopify.com/sitemap.xml',
          credentials: 'OTHER_ORG',
        },
      },
      prune: { keepBuilds: 3, graceDays: 14, maxDelete: 20000 },
    }),
  ],
})
```

| Option | Meaning and default |
| --- | --- |
| `islands` | Path, glob, array of paths/globs, or name-to-path map. Default `src/islands/**/*.vue`. Basenames become island names. A map such as `{ HeroBanner: 'src/sections/Hero.vue' }` supplies explicit names. |
| `exclude` | Array of glob exclusions. Applies only to globs. Default none. |
| `client` | Default `{ entry: 'src/client.ts' }`. Builds fixed-name JS/CSS into theme assets. `false` uses your own client build. |
| `themeDir` | Theme directory relative to project root. Default `theme`. Snippets and optional client assets are written here. |
| `widths` | Nonempty positive integer viewport widths for hydration verification. Default `[375, 1440]`. |
| `store` | Single-store `.myshopify.com` domain, using store id `default`. `SHOPIFY_STORE` overrides this domain. |
| `sitemap` | Full HTTPS sitemap URL paired with `store`. Default none. |
| `stores` | Map of ids to `{ domain, sitemap, credentials? }`. Use this or `store`/`sitemap`. `credentials` names an optional environment-secret suffix. |
| `prune` | `{ keepBuilds: 3, graceDays: 14, maxDelete: 20000 }`. All values are integers, keepBuilds is at least 1, others at least 0. |
| `outDir` | SSR bundle, independent verification bundle, maps and `build.json`. Default `dist-ssr`. |
| `reportDir` | Base report directory. Default `ssr-report`, with a subdirectory per store id. |
| `fixturesDir` | Props JSON grouped by island name. Default `ssr-fixtures`. |

Names start with a letter and contain only letters and digits. Duplicate names and globs with no matches fail. Repeated matches of the same file are deduplicated. Register section-level islands only. Ordinary child imports need no configuration. The demo imports `src/components/SectionLabel.vue` from an island outside the islands glob.

Store ids start with a letter and contain letters, digits or underscores. They must be unique ignoring case. A sole store is selected automatically. With multiple stores, select `--store fr` for store operations. Offline `check` defaults to all configured stores and accepts `--store` to narrow it. Only `init` and `doctor` accept `--all-stores`. Builds and fragment keys are shared across stores while credentials, cache entries, reports and health issues are isolated.

## 5. Wire the client

With `client: { entry: 'src/client.ts' }`, create that entry and import your shared CSS.

```ts
import './styles.css'
import { mountIslands } from 'shopify-vue-ssr/client'
import { registry } from 'virtual:shopify-vue-ssr/islands'

mountIslands({ registry })
```

Load the generated assets from `theme/layout/theme.liquid`, inside the head.

```liquid
{{ 'ssr-client.css' | asset_url | stylesheet_tag }}
<script type="module" src="{{ 'ssr-client.js' | asset_url }}"></script>
```

Only include the CSS tag if your entry or components produce CSS. In your project's `package.json`, use `"build": "shopify-vue-ssr build"` if this is its only bundle. The CLI builds the server, client and verification outputs using your Vite config.

With `client: false`, put the same imports and `mountIslands({ registry })` call into your existing client entry, retain that entry in your Vite build inputs, and keep loading its JS/CSS asset names from Liquid. For example, use `"build": "vite build && shopify-vue-ssr build"` when `vite build` already produces your theme client assets. Build the client and SSR from the same commit and deploy them together. Package-owned builds override conflicting entries/output and SSR runtime settings. Normal Vite builds use your existing configuration.

Keep one mounting runtime per page. It handles Shopify section load/unload events and offers `load`, `unload` and `destroy` for manual lifecycles.

## 6. Convert a section

An existing section might client-render a component through a custom wrapper.

```liquid
<vue-app component="HeroBanner" :title='{{ section.settings.title | json | escape }}'></vue-app>
```

Capture all public props as one-line JSON and call the generated snippet.

```liquid
{%- capture props -%}{"title":{{ section.settings.title | json }},"description":{{ section.settings.description | json }}}{%- endcapture -%}
{% render 'vue-island', component: 'HeroBanner', props: props %}
```

Use Liquid's `json` filter for every value. Use whitespace-control tags in captures and loops. For arrays, emit commas only between items, as shown in `example/theme/sections/feature-list.liquid`. The registered component must accept these prop names. The snippet escapes literal `<` as `\u003c`, hashes those exact transported bytes and embeds the JSON in a `script[data-props]`. Preserve those bytes through hashing and transport.

Add a group containing this setting to `theme/config/settings_schema.json`.

```json
{
  "name": "Rendering",
  "settings": [
    { "type": "checkbox", "id": "ssr_enabled", "label": "Enable SSR cache", "default": true }
  ]
}
```

Add sample props for each registered island under `ssr-fixtures/HeroBanner/default.json`. Fixtures are plain JSON props objects. Use public, synthetic content. The demo has examples for loops, optional content, rich text and an interactive FAQ.

## 7. Shopify access

1. In the Dev Dashboard for the organization owning the store, create an app.
2. Configure `read_metaobjects`, `write_metaobjects`, `read_metaobject_definitions` and `write_metaobject_definitions` on an app version. Release it and install the app on each target store. The definition scopes are required for `init`.
3. Put its client ID and secret in environment variables locally, and GitHub Actions secrets in CI, named `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`.
4. Use the same installed app across stores in its organization. Each domain receives a separate, memory-cached token, refreshed before its 24-hour expiry. The client-secret grant requires the app and store to belong to the same organization. [Shopify client credentials guide](https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant)

Credential precedence is a complete per-store pair such as `SHOPIFY_CLIENT_ID_FR` and `SHOPIFY_CLIENT_SECRET_FR`, then the configured suffix pair such as `SHOPIFY_CLIENT_ID_OTHER_ORG` and `SHOPIFY_CLIENT_SECRET_OTHER_ORG`, then the shared pair. Both values in an override pair must be present. Stores in another organization require their own installed app and override pair. Legacy `SHOPIFY_ADMIN_TOKEN` is also supported, with override pairs taking precedence. Keep secrets in your environment or secret manager.

For the local CLI alternative, install a current Shopify CLI and authenticate each store with the same scopes. Leave package token/client-credential variables unset to use this route.

```sh
npm i -g @shopify/cli@latest
shopify store auth --store example-fr.myshopify.com --scopes read_metaobjects,write_metaobjects,read_metaobject_definitions,write_metaobject_definitions
```

The package then runs `shopify store execute` for Admin operations. Reauthenticate when its saved session expires or scopes change. [Shopify CLI commands](https://github.com/Shopify/cli/blob/main/packages/cli/README.md)

For password-protected storefronts set `SHOPIFY_STOREFRONT_PASSWORD`. The reader submits the storefront password form and keeps cookies for that run. Passwords and cookies are excluded from reports. The Admin API version defaults to `2026-07`.

## 8. First run

Replace `fr` with the configured store id. For a single `store` configuration use `default`.

```sh
npx shopify-vue-ssr init --store fr
npx shopify-vue-ssr islands
npm run build
npx shopify-vue-ssr check --store fr
```

`init` checks or creates the public `ssr_fragment` and private `ssr_build` definitions, writes snippets, and creates the sync workflow and repair guide if absent. Compatible definitions are reused. Incompatible definitions fail with details. Add the plugin yourself using section 4.

Deploy the generated theme assets, `vue-island.liquid` and `ssr-build-id.liquid`, the converted sections and the theme setting through your existing theme deployment process. The deployed client and SSR build must come from the same source. Then populate and inspect the cache.

```sh
npx shopify-vue-ssr sync --store fr --sitemap https://example-fr.myshopify.com/sitemap.xml
npx shopify-vue-ssr doctor --store fr
```

Repeat init and sync for `de`, using its sitemap. You can initialize both with `init --all-stores`. Use `sync --dry-run --store fr` to verify misses without storing them. `doctor` reads coverage and validates keys/build markers. A missing cache entry appears as a miss while the browser renders it.

## 9. CI and optional Shopify Flow

`init` writes `.github/workflows/ssr-sync.yml`. Put it on your default branch and ensure the project build script includes `shopify-vue-ssr build`. It runs `npm ci`, builds, syncs each configured store in a matrix and uploads `ssr-report-<id>` artifacts. It supports manual dispatch, a 30-minute schedule and `repository_dispatch` with event type `ssr-sync`. Its daily `0 3 * * *` UTC run also executes `prune --yes` after a successful full sitemap sync.

| Secret or variable | Use |
| --- | --- |
| Secrets `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` | Shared app credential pair. |
| Secrets `SHOPIFY_CLIENT_ID_<ID>`, `SHOPIFY_CLIENT_SECRET_<ID>` | Optional uppercase store-id override pair. |
| Secrets `SHOPIFY_CLIENT_ID_<SUFFIX>`, `SHOPIFY_CLIENT_SECRET_<SUFFIX>` | Optional configured `credentials` suffix pair. |
| Secret `SHOPIFY_STOREFRONT_PASSWORD` | Protected-store page reader. |
| Variable `SHOPIFY_STORE` | Optional domain override for id `default`. |
| Automatic `GITHUB_TOKEN` | Issue maintenance through `gh`, with workflow `issues: write`. |

Sitemaps come from Vite config. Jobs use per-store concurrency and `fail-fast: false`. Failures and cleanup blocks enter `SSR health - <id>`. Only that store's complete, clean sitemap run closes its issue. Partial clean runs leave it open. Download the artifact, read the store's summary and follow section 14. Deploy the matching build through your existing deployment workflow before sync runs.

For an optional Shopify Flow trigger, create a product-updated workflow and add Send HTTP request. This action requires Grow, Advanced or Plus. Use a fine-grained GitHub token with Contents read/write restricted to your repository, saved as a Flow secret. Set POST URL `https://api.github.com/repos/OWNER/REPO/dispatches`, headers `Accept: application/vnd.github+json`, `Content-Type: application/json` and `Authorization: Bearer <Flow secret>`. [Flow HTTP action](https://help.shopify.com/en/manual/shopify-flow/reference/actions/send-http-request), [GitHub repository dispatch](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event)

```json
{"event_type":"ssr-sync","client_payload":{"store":"fr","urls":["https://example-fr.myshopify.com/products/{{ product.handle }}"]}}
```

Use Flow's variable picker for the handle. Include all public pages affected by a change. Omitting `urls` requests the store's full sitemap. Omitting `store` runs all configured stores. URLs must use HTTPS on the selected store domain or its configured sitemap origin. The scheduled full crawl also covers updates without a configured event trigger. The package installs the GitHub workflow, and the store owner configures Flow separately.

## 10. SSR-safe component rules

- Start server and client with identical state. Use `const open = ref(false)` and update it in a click handler after mount.
- Read browser APIs after mount. For example, `const compact = ref(false)` followed by `onMounted(() => { compact.value = window.matchMedia('(max-width: 40rem)').matches })`. Use CSS for initial responsive layout.
- Keep HTML valid. Render merchant rich text in `<div v-html="description"></div>`. Supply trusted public rich text and keep the same string on both sides.
- Pass stable values as props. Supply a fixed section id for accessible button/panel ids. Avoid time, random values and environment-dependent locale formatting during render.
- Use the same pure entity-decoding function on both sides. Initial render must produce the same tree before browser work begins.
- Hash the exact transported JSON bytes, including whitespace and `\u003c` escapes.

The verification bundle uses a development Vue runtime in a fresh jsdom window at every configured width. These checks cover rendering and hydration. Validate visual layout and device behavior separately. [Vue SSR guidance](https://vuejs.org/guide/scaling-up/ssr.html)

## 11. Troubleshooting and observability

Every `check`, `sync` and `doctor` writes `ssr-report/<storeId>/` and exits nonzero for failures.

| File or signal | Read it for |
| --- | --- |
| `summary.md` | Counts, failure table and repro commands. |
| `report.json` | Build/store identity, coverage, page islands, dry-run and full-crawl status. |
| `failures.jsonl` | Stable failure ids, exact props, mapped stacks and DOM differences. |
| `cases/<id>.json` | Offline repro input with props, widths and diagnostic HTML. |
| `latest-full-crawl.json` | Last complete clean sitemap inventory used by cleanup. Retain it between local runs. |
| `latest-sitemap-run.json` | Latest attempted sitemap run, including failures that block stale-content cleanup. |
| `prune.json` | Selected/kept builds, rule counts, projected/actual sizes and safety blocks. |
| `window.__ssr` | Browser diagnostic arrays `{ hydrated, csr, mismatches }`. |

For a failure, restore the artifact cases directory and run the following commands.

```sh
npx shopify-vue-ssr repro CASE_ID --store fr
npx shopify-vue-ssr repro path/to/case.json --json
npm run build
npx shopify-vue-ssr check --store fr
```

File-path repro needs no store selection and works offline with a local build. Missing fixtures require a JSON props file for every registered island. Hydration mismatches include a first differing DOM path and source-mapped location. A build mismatch requires deploying the matching build and fetching again. Key mismatches require preserving exact props bytes. Render errors and fragments over 65,536 UTF-8 bytes are rejected. Password gates require the reader password. Saved case HTML is diagnostic evidence, and sync renders HTML from local code before verification and storage.

External visitor reporting is disabled until `consent` returns exactly `true`. Use a fixed public page label and your existing consent manager.

```ts
import { mountIslands, callbackReporter } from 'shopify-vue-ssr/client'
mountIslands({
  registry,
  consent: () => yourConsentManager.hasAnalyticsConsent() === true,
  reporter: callbackReporter(event => yourAnalyticsQueue.push(event)),
  page: 'product',
})
```

Built-in `consoleReporter` and `dataLayerReporter('ssr_problem')` are also available. Reporter events contain fixed messages and phase metadata, with props, HTML, raw errors and actual visitor URLs excluded. Keep reports and fixtures free of personal data and credentials.

## 12. Cache cleanup rules and defaults

Preview with `npx shopify-vue-ssr prune --store fr`. Add `--yes` to delete. Defaults are `keepBuilds: 3`, `graceDays: 14` and `maxDelete: 20000`. Override with `--keep-builds`, `--grace-days`, `--max-delete`, or `--older-than 14d` as the grace alias.

1. Keep the confirmed deployed build plus the most recent `keepBuilds - 1` builds by `last_seen`. Delete older-build fragments and history. Verified syncs refresh history even on all-hit runs and rollbacks.
2. Delete unseen kept-build fragments older than grace only after the latest sitemap attempt is a complete, clean crawl of the deployed build. Failed or interrupted attempts block this rule.
3. Delete legacy fragments without build metadata after grace. Seen deployed-build keys remain protected.

Deletion requires deployment confirmation. Exceeding `maxDelete`, including selected history objects, blocks the entire deletion. Old-build and legacy cleanup can run without a clean crawl. Exact-ID bulk batches contain at most 250 objects, retry throttling, recheck deployment and verify deletion jobs. Reports count UTF-8 field-value bytes and exclude HTML from inventory summaries. A failed job leaves after-totals unknown. Read `prune.json` and the cleanup section in `summary.md` after every run.

## 13. CLI reference

| Command | Purpose |
| --- | --- |
| `init --store ID` / `init --all-stores` | Ensure definitions, snippets, sync workflow and repair guide. Existing workflow/guide files are preserved. |
| `stores [--json]` | List configured ids/domains, or JSON ids for CI. |
| `islands` | List resolved names and source paths. |
| `build` | Build SSR, optional client and verification bundles, manifest, maps and snippets. |
| `check [--store ID]` | Render/hydrate each island fixture and saved render failure case at configured widths. Defaults to every configured store. |
| `sync [URL/file...] --store ID` | Verify misses and write cache entries. Supports `--sitemap URL` and `--dry-run`. Defaults to the configured sitemap. |
| `doctor [URL/file...] --store ID` / `doctor --all-stores` | Read coverage and validate keys/deployment. Uses configured sitemap if inputs are omitted. |
| `repro ID --store ID` / `repro path/to/case.json` | Replay local failure. Add `--json` for full detail. |
| `prune --store ID` | Preview cleanup. `--yes` deletes, with optional retention/grace/limit flags. |
| `health-issue --store ID` | Workflow helper to maintain the store's SSR health issue from reports. |

All commands accept `--root DIR` and `--config PATH`. Paths are relative to root. Use explicit page inputs or `--sitemap`. Select a store for remote/report operations when multiple are configured. `build`, `islands`, `stores`, offline `check` and file-path `repro` need no selection. Only `init` and `doctor` accept `--all-stores`. They and an unqualified `check` continue after an individual store fails and return nonzero if any fail.

## 14. For coding agents

To install into an existing repository, follow this checklist.

1. Read its instructions, Vite config, theme layout and package scripts. Identify only public, deterministic section-level islands.
2. Run `npm i -D github:1291pravin/shopify-vue-ssr` and add the section 4 plugin options with the project's real store configuration.
3. Wire `mountIslands` and the virtual registry as in section 5. Set the build script, load its assets, and retain existing theme build steps.
4. Convert sections with one-line captured props JSON and `vue-island`. Add the `ssr_enabled` setting and one synthetic fixture per island.
5. Configure store credentials using section 7. Run `npx shopify-vue-ssr init --store STORE_ID`, then `npx shopify-vue-ssr islands`.
6. Run `npm run build`, `npx shopify-vue-ssr check --store STORE_ID` and the existing project tests. Review the generated workflow, secret names and repair guide.
7. Deploy the matching theme build through the project's authorized process. Run `npx shopify-vue-ssr sync --store STORE_ID`, then `npx shopify-vue-ssr doctor --store STORE_ID`.
8. Commit the code, fixtures and lockfile. Keep generated reports, build outputs and credentials out of Git.

To fix an SSR health issue, use this checklist and the installed `AGENTS.md`. Package contributors should also read the [root guide](AGENTS.md). The [template guide](templates/AGENTS.md) shows what `init` installs into theme projects.

1. Download `ssr-report-STORE_ID` and read `ssr-report/STORE_ID/summary.md`. Restore `cases/` under that report directory.
2. Run `npm ci`, `npm run build` and `npx shopify-vue-ssr repro CASE_ID --store STORE_ID`.
3. Inspect exact props, widths, stack and first DOM difference. Fix deterministic rendering in the source component. Deploy matching code and recapture for build mismatches.
4. Copy the case JSON into `ssr-fixtures/Component/CASE_ID.json`. Rebuild, run `npx shopify-vue-ssr check --store STORE_ID` and existing tests.
5. Open a PR describing the failure, fix, fixture and validation. Deploy the reviewed matching build, sync a full sitemap and inspect the new summary. A clean full crawl lets automation close that store's health issue.
