<script setup lang="ts">
import { ref, watch } from 'vue';

interface Props {
  title: string;
  open?: boolean;         // controlled v-model:open
  defaultOpen?: boolean;  // uncontrolled initial state
  disabled?: boolean;
  subtitle?: string;
}
const props = defineProps<Props>();
const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>();

const isOpen = ref<boolean>(props.open ?? props.defaultOpen ?? false);

watch(
  () => props.open,
  (v) => {
    if (typeof v === 'boolean') isOpen.value = v;
  }
);

function toggle() {
  if (props.disabled) return;
  const next = !isOpen.value;
  isOpen.value = next;
  emit('update:open', next);
}
</script>

<template>
  <div class="w-full rounded-lg border border-white/15 bg-white/5">
    <button
      type="button"
      class="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
      :class="[disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:bg-white/5']"
      @click="toggle"
      :aria-expanded="isOpen"
      :disabled="disabled"
    >
      <div class="min-w-0">
        <div class="font-semibold tracking-wide truncate">
          {{ title }}
        </div>
        <div v-if="subtitle" class="text-sm text-white/80 truncate">
          {{ subtitle }}
        </div>
      </div>
      <div class="shrink-0 flex items-center gap-3">
        <slot name="actions" />
        <i class="pi text-white/80" :class="isOpen ? 'pi-chevron-up' : 'pi-chevron-down'"></i>
      </div>
    </button>

    <div v-show="isOpen" class="px-4 pb-4 pt-1">
      <slot />
    </div>
  </div>
</template>

<style scoped>
</style>