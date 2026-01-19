<script setup lang="ts">
import { RouterLink } from 'vue-router';

interface Props {
  title: string;
  description?: string;
  to?: any;
  icon?: string; // primeicons class suffix, e.g., "pi-users"
  disabled?: boolean;
  badge?: string | number;
  badgeSeverity?: 'success' | 'warn' | 'danger' | 'info';
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
    <div class="shrink-0 flex items-center gap-2">
      <slot name="badge">
        <div 
          v-if="props.badge"
          class="px-2 py-0.5 rounded text-xs font-medium"
          :class="[
            props.badgeSeverity === 'success' ? 'bg-green-500/20 text-green-300' :
            props.badgeSeverity === 'warn' ? 'bg-amber-500/20 text-amber-300' :
            props.badgeSeverity === 'danger' ? 'bg-red-500/20 text-red-300' :
            'bg-white/10 text-white/70'
          ]"
        >
          {{ props.badge }}
        </div>
      </slot>
      <slot name="actions">
        <i v-if="props.to && !props.disabled" class="pi pi-chevron-right text-white/80"></i>
      </slot>
    </div>
  </component>
</template>

<style scoped>
</style>