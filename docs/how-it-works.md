# How it works

`setup` links/creates an app through interactive Shopify CLI, releases metaobject
scopes and waits for installation by polling the client credentials exchange.
The app and store must share a Shopify organization. Credentials come from the CLI
and are saved to ignored .env. `--skip-app` verifies existing credentials; without
credentials the local store auth CLI session can create the definitions instead.
Compatible definitions are reused or extended with missing package fields;
incompatible definitions fail with expected and observed details. Setup writes
Liquid snippets and an absent project repair guide, without rewriting theme wiring.

`build` uses the project's Vite configuration for server, client and independent
browser verification outputs. It copies client assets and the code fingerprint
into the theme. Deploy these together before running `prerender`.

Each island has a component name and exact public props JSON bytes. The key is
`md5(buildId + '|' + component + '|' + exactProps)`. Liquid escapes literal `<` as
`\u003c` before hashing and embedding the JSON. Build identity fingerprints bundled
component code; theme identity alone would serve stale HTML after a code change.

```text
Browser request
      |
      v
Shopify Liquid -> code build + component + exact props -> md5 key
      |
      v
metaobjects.ssr_fragment[key]
      |
      +-- hit  -> cached HTML -> Vue hydration
      |
      +-- miss -> empty root -> Vue client render
```

`prerender <site-url>` expands /sitemap.xml, including same-origin sitemap indexes,
then processes pages with bounded concurrency. A preview adds preview_theme_id to
page requests. Password authentication submits the form once and keeps cookies for
sitemaps and pages. Rejected passwords and challenge pages fail clearly and suggest
saved HTML. `prerender saved.html...` reads local captures instead.

Before any write for a page, its deployed build markers must match the local build.
Only components registered in plugin options are rendered. Hits and duplicate
misses are skipped. Each miss renders from local code, then hydrates using a
separate development Vue compilation in fresh jsdom windows at every configured
width. Only verified HTML within 65,536 UTF-8 bytes can be stored. A page exceeding
20 unique registered keys warns about Liquid's per-type handle lookup limit;
extra islands render in the browser. Captured browser HTML is never the cache value.

Reports include store/build identity, theme ids when present, page coverage and
failures with exact props, mapped stacks and the first differing DOM path. Up to
20 deduplicated exact props samples per component live under
ssr-report/<store>/props/. Optional `check` re-renders and hydrates those samples,
optional fixtures and render failure cases against current code and widths. It
needs no hand-written fixtures and exits successfully with a hint when no props
exist. `repro` replays saved failure evidence offline against the local build.

The private ssr_build history stores first_seen, last_seen and a JSON map from
theme id to observation time. Even all-hit crawls refresh observations. A theme's
latest observed build within the grace/history window is protected, along with the
confirmed build and the most recent keepBuilds minimum. Multiple active themes
can protect more than that minimum. Crawl active preview themes within the window;
history cannot know about themes that have never been observed.

A sitemap prerender purges by default: it keeps only the confirmed deployed
build, its history record and its seen keys. On the live theme (no `--theme`),
other builds' fragments and history are deleted before the crawl once the
storefront confirms the local build; legacy and unseen deployed-build fragments
are deleted after a successful crawl. `--no-delete` skips cleanup
and `--keep-recent` applies the retention policy described above. Saved-file runs
skip cleanup unless `--keep-recent` is given. `--dry-run` renders and verifies and
writes local reports/props, while leaving cache data unchanged. Cleanup inventories
exact ids, requires fresh storefront build confirmation (repeated before each
batch), protects seen keys, enforces maxDelete across fragments and history, and
verifies deletion jobs. A failed run blocks the after-crawl step. Unseen content requires the
latest attempted sitemap crawl to be complete and clean and older than grace;
partial and saved-file runs cannot authorize it. Other active themes sharing a
build block stale-content deletion, and other retained builds' props are protected.
Legacy entries without build metadata require grace. With `--keep-recent`, defaults keep three builds,
use 14 days of grace/history and allow at most 20,000 selected objects.

Everything runs locally or in any CI. The package ships no workflow files or issue
automation. Shopify serves Liquid and cached HTML directly. Each store owns its
cache even when stores share a build. Visitor-specific sections remain client-only.
