import './styles.css'
import { mountIslands } from 'shopify-vue-ssr/client'
import { registry } from 'virtual:shopify-vue-ssr/islands'

mountIslands({ registry })
