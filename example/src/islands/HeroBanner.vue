<script setup lang="ts">
import SectionLabel from '../components/SectionLabel.vue'

defineProps<{
  eyebrow: string
  title: string
  description: string
  linkLabel: string
  linkUrl: string
}>()
</script>

<template>
  <section class="hero">
    <SectionLabel :text="eyebrow" />
    <h1>{{ title }}</h1>
    <p class="description">{{ description }}</p>
    <a :href="linkUrl">{{ linkLabel }} <span aria-hidden="true">&rarr;</span></a>
  </section>
</template>

<style scoped>
.hero { padding: clamp(2rem, 7vw, 5rem); background: #e2e8d6; border-radius: .5rem; }
h1 { max-width: 14ch; margin: 1rem 0; font-size: clamp(2.5rem, 6vw, 4.75rem); font-weight: 400; line-height: 1.05; }
.description { max-width: 42ch; font-size: 1.15rem; line-height: 1.6; }
a { display: inline-block; margin-top: 1rem; color: inherit; font: 600 1rem system-ui, sans-serif; text-underline-offset: .3em; }
</style>
