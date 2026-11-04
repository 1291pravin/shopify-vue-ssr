<script setup lang="ts">
import { onMounted, ref } from 'vue'

const props = defineProps<{
  id: string
  title: string
  items: { question: string; answer: string }[]
}>()

// Start closed on the server and first client render. Enable interaction on mount.
const mounted = ref(false)
const openIndex = ref<number | null>(null)
onMounted(() => { mounted.value = true })

function toggle(index: number) {
  if (mounted.value) openIndex.value = openIndex.value === index ? null : index
}
</script>

<template>
  <section class="faq">
    <h2>{{ title }}</h2>
    <div v-for="(item, index) in items" :key="item.question" class="item">
      <h3>
        <button
          :id="`${props.id}-question-${index}`"
          type="button"
          :aria-expanded="openIndex === index"
          :aria-controls="`${props.id}-answer-${index}`"
          @click="toggle(index)"
        >
          {{ item.question }}
          <span aria-hidden="true">{{ openIndex === index ? '-' : '+' }}</span>
        </button>
      </h3>
      <div
        :id="`${props.id}-answer-${index}`"
        role="region"
        :aria-labelledby="`${props.id}-question-${index}`"
        :hidden="openIndex !== index"
      >
        <p>{{ item.answer }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
h2 { font-size: 2rem; font-weight: 400; }
.item { border-bottom: 1px solid #bcc8b5; }
h3 { margin: 0; }
button { display: flex; justify-content: space-between; gap: 1rem; width: 100%; padding: 1.25rem .25rem; border: 0; color: inherit; background: transparent; text-align: left; font: 600 1rem/1.5 system-ui, sans-serif; cursor: pointer; }
p { max-width: 60ch; padding: 0 .25rem 1rem; line-height: 1.6; }
</style>
