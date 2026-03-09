<script setup lang="ts">
import { useRouter, type RouteLocationRaw } from 'vue-router';

const props = withDefaults(defineProps<{
  to?: RouteLocationRaw | null;
  ariaLabel?: string;
  onClick?: (() => void) | null;
}>(), {
  to: null,
  ariaLabel: 'Back',
  onClick: null,
});

const router = useRouter();

function handleClick() {
  if (props.onClick) {
    props.onClick();
    return;
  }
  if (props.to) {
    void router.push(props.to);
    return;
  }
  router.back();
}
</script>

<template>
  <button
    type="button"
    class="inline-flex h-11 w-11 items-center justify-center rounded-xl text-white bg-white/10 ring-1 ring-white/20 hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 transition-colors active:scale-[0.99]"
    :aria-label="props.ariaLabel"
    :title="props.ariaLabel"
    @click="handleClick"
  >
    <i class="pi pi-arrow-left text-lg" aria-hidden="true"></i>
  </button>
</template>

