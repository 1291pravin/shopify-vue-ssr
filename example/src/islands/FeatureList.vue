<script setup lang="ts">
defineProps<{
  title: string
  introduction: string
  features: { title: string; description: string }[]
  note?: string
}>()
</script>

<template>
  <section class="features">
    <h2>{{ title }}</h2>
    <!-- The theme supplies merchant-authored public rich text. -->
    <div class="introduction" v-html="introduction"></div>
    <ul>
      <li v-for="feature in features" :key="feature.title">
        <h3>{{ feature.title }}</h3>
        <p>{{ feature.description }}</p>
      </li>
    </ul>
    <p v-if="note" class="note">{{ note }}</p>
  </section>
</template>

<style scoped>
.features { padding: 1rem 0; }
h2 { font-size: 2rem; font-weight: 400; }
.introduction, p { line-height: 1.6; }
ul { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 1rem; padding: 0; list-style: none; }
li { padding: 1.5rem; background: #fffdf6; border: 1px solid #d3d9c9; }
h3 { margin-top: 0; font: 600 1.1rem system-ui, sans-serif; }
.note { font-style: italic; }
</style>
