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
