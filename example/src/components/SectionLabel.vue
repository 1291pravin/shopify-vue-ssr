<script setup lang="ts">
defineProps<{ text: string }>()
</script>

<template>
  <p class="section-label">{{ text }}</p>
</template>

<style scoped>
.section-label { font: 700 .8rem/1.4 system-ui, sans-serif; letter-spacing: .12em; text-transform: uppercase; }
</style>
