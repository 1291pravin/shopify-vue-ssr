# SSR repair guide

Configure islands and SSR settings in `shopifyVueSsr({ ... })` in `vite.config`. Use `--config <path>` to select another Vite config. Run `npx shopify-vue-ssr islands` to confirm entry components. Child imports need no registration. Keep aliases, Vue and CSS plugins in Vite. With `client: false`, build the project's client from the same commit as SSR and deploy both before syncing. `init` preserves Vite config.

Run `npx shopify-vue-ssr stores --json` for configured store ids. Select `--store <id>` for store commands when several stores exist. Offline `check` defaults to every configured store. Only `init` and `doctor` accept `--all-stores`. Single-store `store`/`sitemap` options use id `default`. One shared build serves every store with credentials, reports and health issues isolated per store.

1. Read `ssr-report/<storeId>/summary.md` from the `SSR health - <id>` issue's `ssr-report-<id>` workflow artifact.
2. Restore its `cases/` directory under `ssr-report/<storeId>/cases/`. Build local code with `npm ci && npm run build`, then run `npx shopify-vue-ssr repro <id> --store <storeId>` or `repro path/to/case.json`. File-path repro works offline for any store without selecting it. Reports, failures and cases include store id and domain.
3. Read the case's exact props, width, source-mapped stack and first differing DOM path. Fix the source component. A build mismatch needs deployment and a fresh capture, not a cache write.
4. Copy the case JSON into `ssr-fixtures/<Component>/<id>.json`. Run `npx shopify-vue-ssr check --store <storeId>` and `npm test`.
5. Open a PR describing the failure, fix, fixture and validation. Build and deploy the same commit before syncing. Never bypass verification or store captured browser HTML.

SSR-safe rules for theme components

- Never read browser globals in setup or render. Start with stable state and read `matchMedia` inside `onMounted`.
- Use identical initial responsive state, such as `const width = ref(1280)`, on server and client. Let CSS adapt layout before mount.
- Keep valid HTML. Render rich paragraphs in `<div v-html="description"></div>` so paragraph elements remain valid.
- Decode entities with the same pure function on server and client. Avoid DOMParser during initial rendering.
- Avoid time, random IDs and locale-dependent formatting in render. Pass stable values as props.
- Hash exact transported props bytes. Escape literal `<` as `\u003c`. Preserve JSON whitespace and key ordering before hashing.
- Do browser work after mount. Keep server and first client tree identical. CSS may adapt layout before mount.
- No personal data in visitor reports, props fixtures or repository artifacts. Use public theme section props only. Reporters require explicit consent.

For cache cleanup, inspect `ssr-report/<storeId>/prune.json` and the Cache cleanup section of `summary.md`. Prune is dry run by default, and deletion requires a confirmed deployed build.
