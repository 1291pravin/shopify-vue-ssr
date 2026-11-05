# Working on shopify-vue-ssr

This repository root is the reusable npm package. Keep all examples original and
generic. Use placeholder stores such as `example.myshopify.com`. Keep credentials,
personal data, captured storefront pages and generated reports out of Git.
Use plain hyphens. Commit with the configured Git user and no attribution trailers.

## Layout

- `src/` contains native ESM CLI, Vite plugin, client runtime, renderer and cache tools.
- `templates/` contains snippets and guidance installed by `setup`.
- `tests/` contains Node test-runner tests with temporary fixtures and mocked Admin calls.
- `example/` contains an original three-island Vue theme and public props fixtures.
- `docs/how-it-works.md` describes request flow and cache identity.

## Validate changes

1. Run `npm ci` and `npm test` at the root.
2. Run `npm ci`, `npm run build` and `npx shopify-vue-ssr check --store fr` in `example/`.
3. Run `npx shopify-vue-ssr check --store de` for the second report namespace.
4. Run `npm pack --dry-run` at the root. The CLI, declarations and templates must ship.
5. Check the staged diff for private content and generated output before committing.

Tests must work without store credentials or live network requests. Temporary test
projects stay under root `out/` so Node resolves package and peer dependencies.
Preserve exact props bytes for keys, deterministic server/initial client output,
verification before writes, build confirmation and cleanup guards. Keep store
credentials and reports isolated. New public exports need usable declarations.
Put visitor-specific fields in `client_props`; `props` are stored in the public
cache and must never contain personal data.
Validate changes through the CLI and installed package as well as direct functions.

## Public workflow

- Commands are setup, build, prerender, check and repro. Keep --help and README
  flags in agreement. Do not ship CI workflows or issue automation.
- Setup is interactive for app creation/linking and release. Obtain credentials
  through Shopify CLI; never request pasted secrets. The app and store must share
  a Shopify organization. Keep the store auth CLI alternative usable.
- Build before theme deployment. Prerender verifies matching deployed code before
  storing rendered HTML. Theme ids are history metadata; cache keys use code builds.
- Capture bounded, deduplicated real props per store for optional offline check.
  Fixtures are optional. Check with no props is a successful first run with a hint.
- Delete cache data only through prerender --cleanup. Dry-run previews deletion;
  preserve build confirmation, recent observed themes, full-crawl and size guards.
- Do not push or create remote resources unless explicitly instructed by the owner.
