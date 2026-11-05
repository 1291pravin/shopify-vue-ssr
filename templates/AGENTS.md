# Working on a Vue SSR theme

Use `shopifyVueSsr` in the existing Vite config. Keep Vue/CSS plugins, aliases and
defines. Register section-level islands; child imports need no registration.
`build` and `prerender` list the selected islands. Use `--config PATH` for another
Vite config and `--root DIR` for another project directory.

Install checklist:

1. Install the package and add the plugin and client mounting entry from README.
2. Run `npx shopify-vue-ssr setup --store your-store.myshopify.com` interactively.
   Choose/create the app in the store owner's Shopify organization, release the
   scopes, and install the app while setup waits. It obtains secrets through CLI,
   creates compatible definitions, writes ignored `.env` and installs snippets.
   Reruns are safe; `--timeout SECONDS` changes the wait. With existing credentials
   or an authenticated `shopify store auth` session, use `--skip-app`.
3. Wire the build meta tag, client assets, ssr_enabled setting and exact one-line
   JSON section captures. Setup does not rewrite Vite, layout, settings or sections.
4. Build before deploying the theme. With `client: false`, build your client from
   the same commit. Deploy both snippets, assets and converted sections together.
5. Run `npx shopify-vue-ssr prerender https://example.com`, optionally with
   `--theme ID`. The supplied site's same-host sitemap is expanded automatically.
   Saved `.html` files also work. Passwords belong in SHOPIFY_STOREFRONT_PASSWORD
   or a variable selected by `--password-env NAME`, never a CLI password value.
6. Read `ssr-report/<store>/summary.md`. Reports and exact real props are captured
   locally. Do not commit credentials, captured props, HTML or reports.

For multiple stores, use ids from the plugin's `stores` map with `--store ID`.
`check` defaults to every configured store. Each store has its own credentials,
reports, captured props and Admin cache. Builds are shared by component code;
theme ids are history metadata and never replace build ids in cache keys.

Repair checklist:

1. Read summary.md and the saved case. Run `npx shopify-vue-ssr repro CASE_ID --store ID`
   or `npx shopify-vue-ssr repro path/to/case.json --json` against a local build.
2. Use exact props, configured widths, mapped stacks and the first differing DOM
   path. A build mismatch needs matching deployment and a fresh capture.
3. Fix the source. Server and initial client trees must match. Read browser APIs
   in onMounted, use CSS for initial responsive behavior, pass stable ids as props,
   avoid time/random/locale-dependent output and keep HTML valid. Put rich text
   in a div. Use the same pure entity decoder on both sides.
4. Run build and `npx shopify-vue-ssr check --store ID`. It reuses the last prerender's
   props and any optional ssr-fixtures/<Component>/*.json. No hand-written fixtures
   are required. No saved props yet exits successfully with a hint.
5. Deploy the matching build and prerender again. Never bypass hydration checks or
   store captured browser HTML. Hash exact transported JSON, including whitespace,
   ordering and literal-less-than escapes (\u003c).

Nothing is deleted without `prerender --cleanup`. First inspect a run with
`--cleanup --dry-run` and read prune.json. Cleanup protects recent observed themes
and retained builds, requires fresh build confirmation and a clean full crawl for
stale-content removal, and enforces a deletion ceiling. Crawl every active theme
within the configured grace window. Report local proof separately from live proof.
