<script setup lang="ts">
import { RouterLink } from 'vue-router';

interface Props {
  title: string;
  description?: string;
  to?: any;
  icon?: string; // primeicons class suffix, e.g., "pi-users"
  disabled?: boolean;
}
const props = defineProps<Props>();
</script>

<template>
  <component
    :is="props.to && !props.disabled ? RouterLink : 'div'"
    :to="props.to as any"
    class="group relative flex items-center gap-3 px-4 py-3 border-b last:border-b-0 rounded-none"
    :class="[
      'transition-colors',
      'border-white/15',
      props.disabled ? 'opacity-60 cursor-not-allowed' : 'hover:bg-white/5 cursor-pointer'
    ]"
    role="button"
    :aria-disabled="props.disabled || undefined"
  >
    <div class="shrink-0">
      <i :class="['pi', props.icon || 'pi-circle', 'text-xl', 'text-white']"></i>
    </div>
    <div class="min-w-0 flex-1">
      <div class="font-semibold tracking-wide truncate">
        {{ props.title }}
      </div>
      <div v-if="props.description" class="text-sm text-white/80 truncate">
        {{ props.description }}
      </div>
    </div>
    <div class="shrink-0">
      <slot name="actions">
        <i v-if="props.to && !props.disabled" class="pi pi-chevron-right text-white/80"></i>
      </slot>
    </div>
  </component>
</template>

<style scoped>
</style>