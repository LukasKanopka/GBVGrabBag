<script setup lang="ts">
interface Props {
  title: string;
  subtitle?: string;
  divider?: boolean; // show bottom divider
}
const props = defineProps<Props>();

// Volar slot typing for named slots
const slots = defineSlots<{
  default?: () => any;
  actions?: () => any;
}>();
</script>

<template>
  <div
    class="w-full"
    :class="props.divider ? 'pb-3 mb-3 border-b border-white/15' : 'pb-1'"
  >
    <div class="flex items-center justify-between gap-3">
      <div class="min-w-0">
        <h2 class="text-xl sm:text-2xl font-extrabold tracking-tight truncate">
          {{ props.title }}
        </h2>
        <p v-if="props.subtitle" class="mt-0.5 text-sm text-white/80 truncate">
          {{ props.subtitle }}
        </p>
      </div>
      <div class="shrink-0">
        <!-- Support both a named 'actions' slot and default slot for right-aligned actions -->
        <slot name="actions" />
        <slot />
      </div>
    </div>
  </div>
</template>

<style scoped>
</style>