# shopify-vue-ssr

Render public Vue islands before requests and cache verified HTML in Shopify
metaobjects. Liquid serves cache hits and the browser hydrates them. Cache misses
render in the browser. No rendering server or request proxy is needed.

Use this for public theme sections whose complete inputs are in props. Keep carts,
accounts, visitor-specific prices and other private state client-rendered.
[Request flow and cache identity](docs/how-it-works.md).

## Requirements

- Node `^22.13.0 || >=24.0.0`, Vite 8, Vue 3.5, and `@vitejs/plugin-vue` 6.
- An existing Vite + Vue Shopify theme project with a committed npm lockfile.
- Current [Shopify CLI](https://shopify.dev/docs/api/shopify-cli), app management
  permission in the store owner's organization, and an existing theme deployment process.
- For app credentials, the app and store must belong to the **same Shopify
  organization**. Installation alone does not meet this requirement.
  [Client credentials grant](https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant).

## Quick start

1. Install in the theme project's root:

   ```sh
   npm i -D github:1291pravin/shopify-vue-ssr
   npm i -g @shopify/cli@latest
   ```

2. Add the plugin to the existing Vite config, preserving aliases, defines, Vue
   options and other plugins:

   ```ts
   import { defineConfig } from 'vite'
   import vue from '@vitejs/plugin-vue'
   import { shopifyVueSsr } from 'shopify-vue-ssr'

   export default defineConfig({
     plugins: [vue({ template: { compilerOptions: { comments: false } } }), shopifyVueSsr({
       islands: 'src/islands/**/*.vue',
       client: { entry: 'src/client.ts' },
       themeDir: 'theme',
       store: 'your-store.myshopify.com',
     })],
   })
   ```

   In `src/client.ts`, import shared CSS and mount the registered islands:

   ```ts
   import './styles.css'
   import { mountIslands } from 'shopify-vue-ssr/client'
   import { registry } from 'virtual:shopify-vue-ssr/islands'
   mountIslands({ registry })
   ```

   Set `"build": "shopify-vue-ssr build"` in the project's package scripts.
   Register section-level islands only; ordinary child imports need no registration.

3. Set up once per store, then finish the local theme wiring below:

   ```sh
   npx shopify-vue-ssr setup --store your-store.myshopify.com
   ```

   Shopify CLI inherits the terminal for organization/app selection and deployment.
   Choose or create the app in the organization owning the store. Setup releases
   the required scopes, retrieves credentials without asking you to paste them,
   prints installation instructions, and polls until the store grants access.
   Install the released app using its Dev Dashboard distribution/install link.
   Ctrl+C cancels safely; rerun setup to continue. The default wait is 600 seconds.

   Setup creates/reuses the `ssr_fragment` and private `ssr_build` definitions,
   installs snippets, writes credentials to ignored `.env`, and installs `AGENTS.md`
   only if absent. Existing compatible definitions and the build id are preserved.
   Existing app configuration values are retained; required scopes are added.
   [App configuration](https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration),
   [app config link](https://shopify.dev/docs/api/shopify-cli/app/app-config-link),
   [app env show](https://shopify.dev/docs/api/shopify-cli/app/app-env-show).

   Load these in `theme/layout/theme.liquid` inside the head:

   ```liquid
   {%- capture ssr_build -%}{%- render 'ssr-build-id' -%}{%- endcapture -%}
   <meta name="ssr-build-id" content="{{ ssr_build }}">
   {{ 'ssr-client.css' | asset_url | stylesheet_tag }}
   <script type="module" src="{{ 'ssr-client.js' | asset_url }}"></script>
   ```

   Omit the CSS tag if the build produces no CSS. Add a Rendering group with this
   setting to the theme's `config/settings_schema.json` array:

   ```json
   { "name": "Rendering", "settings": [
     { "type": "checkbox", "id": "ssr_enabled", "label": "Enable SSR cache", "default": true }
   ] }
   ```

   Convert each public section to a one-line JSON capture and snippet call. Prop
   names must match the Vue component. Use `json` for every Liquid value and
   whitespace-control tags for captures and loops:

   ```liquid
   {%- capture props -%}{"title":{{ section.settings.title | json }}}{%- endcapture -%}
   {% render 'vue-island', component: 'HeroBanner', props: props %}
   ```

   No hand-written fixtures are required. Setup does not rewrite your Vite config,
   sections, layout or settings; the snippets above are the required wiring.

4. Build before deploying the theme:

   ```sh
   npm run build
   ```

   This lists islands and creates client, server and independent verification
   bundles. It copies client assets and `snippets/ssr-build-id.liquid` into the theme.
   The build id fingerprints bundled component code. It is deliberately the cache
   identity: a theme id alone would reuse stale HTML after code changes.

5. Deploy the generated theme directory through your existing deployment process:

   ```sh
   shopify theme push --path theme --store your-store.myshopify.com
   ```

   Select the intended theme in Shopify CLI. Deploy assets, both snippets, converted
   sections, layout and settings together from the same build. A normal deployment
   is separate from app setup. The package never uploads a theme.

6. Populate the cache and capture real props:

   ```sh
   npx shopify-vue-ssr prerender https://example.com
   ```

   This expands `/sitemap.xml` on that site's host, fetches pages, verifies the
   deployed build, renders registered misses, hydrates at the configured widths,
   and stores verified fragments. Other components stay client-rendered. Failures
   produce reports and a nonzero exit. Cache hits are skipped. Run again when
   public content changes. `check` is optional before later deployments.

## Migrating sections from `<vue-app>`

For an existing multiline `component_props` capture, transport its JSON on one
line. Keep string values escaped with Liquid's `json` filter; real newlines inside
strings must already be escaped as `\n`:

```liquid
{%- capture island_props -%}{{ component_props | strip | strip_newlines }}{%- endcapture -%}
<div id="hero-section" data-sticky-nav-label="{{ section.settings.title | escape }}">
  {% render 'vue-island', component: 'HeroBanner', props: island_props %}
</div>
```

Move attributes previously on `<vue-app>`, such as ids or data attributes selected
by navigation and other scripts, onto this wrapper or the Shopify section element.
Add the new custom element to your shared stylesheet:

```css
vue-island { display: block; }
```

Trailing commas make the props JSON invalid. `strip | strip_newlines` removes
whitespace; it does not repair JSON. Prerender and the client loader report the
component, page and JSON parse error. Browser details remain in the local console
and `window.__ssr.mismatches`; optional reporters still send fixed metadata only.
Preserve the resulting exact JSON bytes for cache keys and hydration.

## Plugin options

| Option | Default | Meaning |
| --- | --- | --- |
| `islands` | `src/islands/**/*.vue` | Path, glob, array, or name-to-path map such as `{ HeroBanner: 'src/sections/Hero.vue' }`. Basenames supply names for paths/globs. |
| `exclude` | `[]` | Glob exclusions; plain file paths are unaffected. |
| `client` | `{ entry: 'src/client.ts' }` | Build fixed-name JS/CSS. `false` uses your existing client build. |
| `nestedBuild` | `{ excludePlugins: [] }` | Additional plugin names (exact strings) or `RegExp` patterns to skip in server/verification builds. Built-in theme tooling exclusions always apply. |
| `themeDir` | `theme` | Local destination for snippets and client assets. |
| `widths` | `[375, 1440]` | Nonempty positive integer hydration verification widths. |
| `store` | unset | Single `.myshopify.com` domain, store id `default`; `SHOPIFY_STORE` overrides it. |
| `sitemap` | unset | Optional HTTPS sitemap used as the cleanup probe origin with saved HTML. URL prerender always reads the supplied site's `/sitemap.xml`. |
| `stores` | unset | Map of ids to `{ domain, sitemap?, credentials? }`; use instead of `store`/`sitemap`. `credentials` is an environment suffix for a separate organization. |
| `prune` | `{ keepBuilds: 3, graceDays: 14, maxDelete: 20000 }` | Cleanup policy, used only with `prerender --cleanup`. Integers: keepBuilds >= 1; others >= 0. |
| `outDir` | `dist-ssr` | Server/verification bundles, maps and `build.json`. |
| `reportDir` | `ssr-report` | Base directory; reports and captured props live in a subdirectory per store id. |
| `fixturesDir` | `ssr-fixtures` | Optional props JSON under `<Component>/*.json`. |

Names start with a letter and contain letters/digits only. Duplicate names,
invalid widths and unmatched globs fail. Store ids start with a letter and contain
letters, digits or underscores; ids are unique ignoring case. For `stores`, select
`--store ID` for setup/prerender; `check` defaults to all stores. Builds are shared;
credentials, reports, props and cache contents are isolated per store. Setup also
saves a suffix pair for named store ids, so setting up another store retains access.
`SHOPIFY_STORE` affects only single-store configuration.

With `client: false`, mount islands in your existing entry and load its actual
assets from Liquid. Use `"build": "vite build && shopify-vue-ssr build"` if
`vite build` owns the client output. Build and deploy both from the same commit.

If that entry already uses `import.meta.glob` and `defineAsyncComponent`, importing
`virtual:shopify-vue-ssr/islands` there defeats lazy loading: the virtual registry
statically imports every island, putting them in the entry/shared bundle and
causing `INEFFECTIVE_DYNAMIC_IMPORT` warnings. Share a name-to-path map between
your Vite config and browser entry, for example `ssr/islands.ts`:

```ts
export const islands = { HeroBanner: 'src/sections/HeroBanner.vue' }
```

Pass this map to `shopifyVueSsr({ islands, client: false })` in the Vite config.
In the browser, select from your existing component map using the helper:

```ts
import { islands } from '../ssr/islands'
import { components } from './components' // Existing sync/defineAsyncComponent map
import { createIslandRegistry, mountIslands } from 'shopify-vue-ssr/client'

const registry = createIslandRegistry(Object.keys(islands), components, {
  warn: message => console.warn(message), // Optional; defaults to console.warn
})
mountIslands({ registry })
```

`createIslandRegistry` accepts an iterable of names and a component map, preserves
sync and `defineAsyncComponent` values, and warns for missing names. It does not
invoke loaders. Async roots work for both hydration and client rendering. Server
and verification builds keep using the plugin's static virtual registry.

### When hydration does not match

`mountIslands({ registry, onMismatch })` decides what happens when the stored HTML
differs from what the browser renders, for example a header whose real props carry
a cart count of 3 while the stored fragment shows 0:

| `onMismatch` | Behaviour |
| --- | --- |
| `'keep'` (default) | Stay hydrated. Vue patches the differing text and the island keeps working; the mismatch is logged in `window.__ssr.mismatches` and reported. |
| `'remount'` | Discard the stored HTML and render the island again in the browser with the same props. Guarantees the client output, at the cost of a brief redraw. |

An island that throws while hydrating is always remounted in the browser, whatever
the setting. Remounted islands appear in `window.__ssr.csr` with `recovered: true`
and their root gets `data-ssr-recovered="1"`. Note that Vue does not fix mismatched
attributes (such as `class`) in production; use `'remount'` if an island depends on them.

### Theme tooling in nested builds

Server and verification builds automatically skip the plugins that write into the
theme: `vite-plugin-shopify-html` (rewrites `snippets/vite-tag.liquid`), the
dev-only `vite-plugin-shopify:*` helpers, and `vite-plugin-shopify-clean` (the name
used by `@driver-digital/vite-plugin-shopify-clean`). `vite-plugin-shopify-config`
keeps running because it provides the `~` and `@` import aliases; this package
overrides its output folder. Each skipped plugin is logged.
This prevents nested builds from rewriting theme snippets or cleaning assets
just produced by `vite build`. Normal and package-owned client builds retain them.
Other plugins, aliases and defines are preserved; conflicting package output/SSR
settings are overridden. Normal Vite builds retain their settings.

Exclude other theme writers by plugin name:

```ts
shopifyVueSsr({
  client: false,
  nestedBuild: { excludePlugins: ['custom-theme-clean', /^theme-assets-/] },
})
```

For plugins you control, the package exposes `config.shopifyVueSsrBuild` with
`kind: 'server' | 'verify' | 'client'`. Gate theme writes with `apply` so they run
only in normal/client builds:

```ts
const themeWriter = {
  name: 'custom-theme-writer',
  apply: config => !config.shopifyVueSsrBuild || config.shopifyVueSsrBuild.kind === 'client',
  // Your theme-writing hooks here.
}
```

Exclusions take effect before plugin hooks, including `apply` and `config`.

## Command reference

Commands run in the theme project root. Paths are relative to `--root`. Help works
without a configured project. Every supported flag is listed below.

### setup

Create/link and release the app, wait for installation, and install definitions and snippets.

```sh
npx shopify-vue-ssr setup --store your-store.myshopify.com --timeout 900
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--store <DOMAIN_OR_ID>` | sole configured store | Store domain or configured id. Required when several stores exist. |
| `--app-name <NAME>` | ssr-renderer | Name used when writing a new app config. |
| `--skip-app` | false | Verify environment credentials, or use the existing store auth CLI session; skip app creation/deployment. |
| `--timeout <SECONDS>` | 600 | Maximum time to wait for app installation. |
| `--root <DIR>` | . | Project directory. |
| `--config <PATH>` | Vite discovery | Vite config path relative to root. |
| `--help` | false | Show command help without loading a project. |

### build

List islands, build client/server/verification bundles, and copy assets and build id into the theme.

```sh
npx shopify-vue-ssr build
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--root <DIR>` | . | Project directory. |
| `--config <PATH>` | Vite discovery | Vite config path relative to root. |
| `--help` | false | Show command help without loading a project. |

### prerender

Crawl a same-host sitemap or read saved HTML; render and verify cache misses before storing.

```sh
npx shopify-vue-ssr prerender https://example.com --limit 10 --dry-run
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--store <ID>` | sole configured store | Select the store for credentials and reports. |
| `--theme <ID>` | published theme | Add preview_theme_id to page requests for this numeric theme id. |
| `--password-env <NAME>` | SHOPIFY_STOREFRONT_PASSWORD | Environment variable containing the storefront password. |
| `--dry-run` | false | Render, verify and write local reports/props; do not change cache data. |
| `--cleanup` | false | Run guarded cache cleanup after a successful crawl; dry-run previews deletions. |
| `--limit <N>` | all pages | Positive maximum number of pages; partial crawls cannot authorize stale-content deletion. |
| `--concurrency <N>` | 2 | Pages fetched at once. Failed requests with HTTP 429 are retried with backoff; use 1 if Shopify still rate-limits. |
| `--root <DIR>` | . | Project directory. |
| `--config <PATH>` | Vite discovery | Vite config path relative to root. |
| `--help` | false | Show command help without loading a project. |

### check

Re-render and hydrate saved real props plus optional fixtures. No props is a successful first run.

```sh
npx shopify-vue-ssr check --store default
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--store <ID>` | all configured stores | Narrow the offline checks and report namespace to one store. |
| `--json` | false | Print machine-readable check counts. |
| `--root <DIR>` | . | Project directory. |
| `--config <PATH>` | Vite discovery | Vite config path relative to root. |
| `--help` | false | Show command help without loading a project. |

### repro

Replay a saved failure against the current local build.

```sh
npx shopify-vue-ssr repro path/to/case.json --json
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--store <ID>` | sole configured store for ids | Select the report namespace when using a case id; file paths need no store. |
| `--json` | false | Print full reproduction details as JSON. |
| `--root <DIR>` | . | Project directory. |
| `--config <PATH>` | Vite discovery | Vite config path relative to root. |
| `--help` | false | Show command help without loading a project. |

For `setup --skip-app`, a complete client ID/secret pair from the environment is
verified once. No app configuration is written or deployed. Definitions/snippets,
ignored `.env` and an absent repair guide are still installed. Local authentication
also works without client credentials: authenticate first with the required scopes,
then use the same command. Admin operations use Shopify CLI's saved session:

```sh
shopify store auth --store your-store.myshopify.com --scopes read_metaobjects,write_metaobjects,read_metaobject_definitions,write_metaobject_definitions
npx shopify-vue-ssr setup --store your-store.myshopify.com --skip-app
```

Keep the client credential and legacy token variables unset to use that route.
Do not commit `.env`, reports, saved HTML or captured real props. Retain local
`ssr-report/<store>/props/` between runs so `check` can reuse them. Optional fixture
files contain plain props objects. Captured samples preserve exact JSON bytes,
are deduplicated, and are capped at 20 per component across runs, preferring the
latest run's props. Failure cases
are also regression inputs. Check uses the current configured widths.

## Environment variables

The CLI loads project `.env`; existing process variables take precedence.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHOPIFY_STORE` | plugin single-store domain | Admin domain for id `default`; ignored for explicit `stores` maps. |
| `SHOPIFY_CLIENT_ID` | unset | Shared app client ID, written by setup. |
| `SHOPIFY_CLIENT_SECRET` | unset | Shared app secret, written by setup; never logged. |
| `SHOPIFY_CLIENT_ID_<ID>`, `SHOPIFY_CLIENT_SECRET_<ID>` | unset | Complete pair overriding shared credentials for an uppercase store id. |
| `SHOPIFY_CLIENT_ID_<SUFFIX>`, `SHOPIFY_CLIENT_SECRET_<SUFFIX>` | unset | Complete pair selected by the store's `credentials` option, after the id pair. |
| `SHOPIFY_ADMIN_TOKEN` | unset | Legacy direct Admin token; used if no store override pair is selected. Leave unset for client credentials or CLI auth. |
| `SHOPIFY_STOREFRONT_PASSWORD` | unset | Storefront reader password. Select a different variable with `--password-env NAME`. |

The Admin API version is `2026-07`. Client credentials tokens are exchanged per
store, cached in memory, and refreshed before their 24-hour expiry. Incomplete
override pairs fail; credentials from different organizations must never be mixed.

## Preview and unpublished themes

Deploy the build to the intended theme, then use its numeric id:

```sh
shopify theme push --path theme --store your-store.myshopify.com --theme 123456789
npx shopify-vue-ssr prerender https://example.com --theme 123456789
```

The sitemap retains its host; each page request includes `preview_theme_id`.
A fetched theme/build mismatch stores nothing for that page. Deploy the matching
local build or build the matching commit, then retry. Theme ids from page metadata
are recorded alongside build history. Cache is shared by code build, so publishing
that same theme needs no refill. Pages without islands should carry the layout's
build meta tag to prove that a full crawl is safe for cleanup.

## Password-protected stores

Set `SHOPIFY_STOREFRONT_PASSWORD` in ignored `.env` or your secret manager, then run
prerender normally. Never pass a password value on the command line. Prerender opens
the homepage first, logs in through the password page there, and then fetches
`sitemap.xml` with that session (Shopify does not show the password form on the
sitemap itself). For another secret variable, select its **name**:

```sh
npx shopify-vue-ssr prerender https://example.com --password-env PREVIEW_PASSWORD
```

The reader submits the storefront form once and retains cookies for sitemap and
page requests. Password rejection or a challenge page stops that fetch with a
saved-HTML hint. Export the matching theme's HTML through an authenticated browser,
keep it outside Git, and pass those local files:

```sh
npx shopify-vue-ssr prerender captures/home.html captures/product.html --dry-run
```

Saved HTML also requires matching build/key markers. It supplies props; the local
renderer supplies the stored HTML. A saved-file run cannot authorize stale-content
cleanup; other cleanup rules still require fresh storefront build confirmation.

## Running in CI

Run setup interactively once. Supply the app credentials through your CI secret
manager and keep reports/props as private artifacts for the next check. Deploy the
matching theme build before prerender. These are inline examples only; the package
ships no workflows and creates no issues.

GitHub Actions step in your existing job, after checkout, Node setup and deployment:

```yaml
- name: Fill SSR cache
  run: npm ci && npm run build && npx shopify-vue-ssr prerender https://example.com
  env:
    SHOPIFY_CLIENT_ID: ${{ secrets.SHOPIFY_CLIENT_ID }}
    SHOPIFY_CLIENT_SECRET: ${{ secrets.SHOPIFY_CLIENT_SECRET }}
```

Ensure the build matches the theme your deployment job produced. A job that builds
first can put its existing deployment step between build and prerender instead.

GitLab job following your existing matching-build deployment stage, with masked
`SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` CI variables:

```yaml
ssr_cache:
  stage: post-deploy
  script:
    - npm ci
    - npm run build
    - npx shopify-vue-ssr prerender https://example.com
```

## Cache cleanup

Nothing is deleted unless `--cleanup` is supplied. Preview candidates first:

```sh
npx shopify-vue-ssr prerender https://example.com --cleanup --dry-run
npx shopify-vue-ssr prerender https://example.com --cleanup
```

`prune.keepBuilds` retains the confirmed fetched build plus the most recently seen
builds up to its minimum (default 3). It additionally protects each theme's latest
observed build within `graceDays` (default 14 days), even if this exceeds keepBuilds.
Prerender refreshes history on hits as well as fills. Only themes observed by
prerender are known; crawl other active themes within that window to protect them.

Old unprotected builds can be deleted. Unseen content for the crawled build requires
a complete, clean sitemap crawl, the latest attempt's agreement, and age beyond
grace. Other active themes sharing that build conservatively block stale-content
cleanup. Other retained builds' props are protected. Legacy fragments without build
metadata require grace. Seen keys stay protected, including after a failed run.

Failures block cleanup for the run. Partial/saved-file runs block stale-content
cleanup. Fresh build confirmation is repeated before each deletion batch; a changed
build stops deletion. `maxDelete` (default 20000) includes fragments and build history
and blocks the entire deletion if exceeded. Exact-id batches contain at most 250
objects, retry throttling and verify deletion jobs. Unknown outcomes retain unknown
after-totals. Review `prune.json` and the cleanup section of `summary.md`.
`--dry-run` still writes local reports and samples, but changes no cache data.

## Troubleshooting and reports

For themes using `vite-plugin-shopify`, inspect the generated `vite-tag.liquid`
when assets look stale. Keep Shopify's `?v=` cache busting on stylesheet tags
(`asset_url | stylesheet_tag`); removing it can leave old CSS cached even after
uploading new contents under the same hashed filename. When JS chunks import the
entry by bare filename, keep the JS entry, chunks and modulepreload URLs
unversioned consistently. Adding `?v=` only to the entry creates a second module
identity and can evaluate it twice. Apply stylesheet versioning separately from
script/modulepreload URLs in your theme tooling.

`prerender`, `check` and failing cases write `ssr-report/<store>/`. Failures exit
nonzero. `repro` replays existing cases and exits nonzero if a failure remains.
No props yet is a successful `check` with a hint to run prerender.

After updating this package, run `npx shopify-vue-ssr setup --skip-app` (with
`--store <id>` for multi-store configs) once per store. It adds any new fields to
the existing definitions without touching cached entries. If you skip it,
`prerender` stops with a message telling you to run it.

| Signal/file | Meaning |
| --- | --- |
| `window.__ssr` | Browser arrays `{ hydrated, csr, mismatches }`; misses render in the browser. |
| `summary.md` | Counts, failures, warnings and repro commands. |
| `report.json` | Store/build identity, page coverage, theme ids, full-crawl/dry-run state and cleanup result. |
| `failures.jsonl` | Stable case ids, exact props, mapped stacks and first differing DOM paths. |
| `cases/<id>.json` | Offline repro inputs and diagnostic HTML. |
| `props/<Component>/*.json` | Up to 20 exact real props samples per component for check. |
| `latest-full-crawl.json` | Last clean complete sitemap inventory. Retain between runs. |
| `latest-sitemap-run.json` | Latest attempted crawl, including incomplete attempts that block stale-content cleanup. |
| `prune.json` | Cleanup candidates, guards, selected/kept builds and UTF-8 field-value byte totals. |

```sh
npx shopify-vue-ssr repro CASE_ID --store default
npx shopify-vue-ssr repro path/to/case.json --json
npx shopify-vue-ssr check
```

A build mismatch needs a matching deployment/fresh capture. A key mismatch needs
exact props bytes; do not reformat JSON before hashing. Rendering errors, hydration
mismatches and fragments over 65,536 UTF-8 bytes block the fragment write. More than
20 unique registered cache keys on a page warns about Shopify's handle lookup limit;
extra islands stay client-rendered. Smaller islands or fewer sections can reduce it.

Browser reporters are optional. `callbackReporter`, `consoleReporter` and
`dataLayerReporter` from `shopify-vue-ssr/client` require `consent` to return exactly
`true` before events leave the mounting runtime. Use a fixed public `page` label.
Events omit props, HTML, raw errors and visitor URLs. Keep one mounting runtime per
page; Shopify section load/unload is supported. Manual `load`, `unload` and `destroy`
are available on the returned runtime.

## SSR-safe component rules

- Use `vue({ template: { compilerOptions: { comments: false } } })` in the shared
  Vite config so production SSR/client and development verification agree on
  template comments. Build warns when the Vue plugin explicitly exposes
  `comments: true`; defaults or uninspectable configurations are covered by this
  rule without guessing their behavior.
- Mount `Teleport` only when open, for example
  `<Teleport v-if="open" to="#modal-root">...</Teleport>`, with `open` initially
  false on both server and client. Gate the Teleport itself; hiding only its
  contents leaves Teleport markers in the initial tree.
- Start server and first client render with identical state. Toggle reactive state
  only after interaction or mount. Use CSS for initial responsive layout.
- Read `window`, `document`, `matchMedia` and other browser APIs in `onMounted`.
- Keep valid HTML. Render trusted merchant rich text in `<div v-html="description">`
  rather than nesting paragraphs inside a paragraph.
- Pass stable section ids, dates, locale and all public inputs as props. Avoid time,
  random values and environment-dependent formatting during render.
- Decode entities using the same pure function on server and client.
- Preserve the exact transported JSON bytes, including key order, whitespace and
  `\u003c` escapes. The snippet escapes literal `<` before hashing/transport.
- Use Vue Composition API with `<script setup lang="ts">` for new components.

Verification uses a separate development Vue browser bundle in a fresh jsdom window
at every width. It checks render/hydration behavior; test real browser layout,
interaction and devices separately. [Vue SSR guide](https://vuejs.org/guide/scaling-up/ssr.html).

## For coding agents

Install checklist:

1. Read existing Vite/client/theme wiring. Preserve unrelated plugins and work.
2. Install the package, add the plugin and client mounting entry (quick start 1-2).
3. Run setup in the owner's terminal; use the store owner's organization and finish installation.
4. Wire the layout build marker/assets, Rendering setting and exact JSON section captures.
5. Build, deploy that build through the owner's deployment process, then prerender.
6. Read the store report. Keep `.env`, captures, reports and real props out of Git.
   No mandatory fixtures, workflow files or issue integration are needed.

Repair checklist:

1. Read `summary.md`, then the exact failure under `cases/`; run `repro` by id or path.
2. Restore saved props/cases locally. Build the matching code before reproducing.
3. Fix the component using the exact props, configured widths, mapped source line
   and first DOM difference. Fix transport/deployment problems at their source.
4. Build and run check against saved props plus optional synthetic fixtures. Never
   bypass verification or store captured browser HTML.
5. Deploy the matching build and prerender again. Review cleanup candidates with
   dry-run before requesting deletion. Report local checks separately from live proof.

The original three-island example includes optional synthetic fixtures. To validate
this repository: root `npm ci`, `npm test`; in `example/`, `npm ci`, `npm run build`,
`npx shopify-vue-ssr check --store fr`, then `npx shopify-vue-ssr check --store de`;
finally root `npm pack --dry-run`. The package ships native ESM and declarations.
