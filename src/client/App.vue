<script setup lang="ts">
import { RouterView } from 'vue-router';
import { Toaster } from 'vue-sonner';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
</script>

<template>
  <RouterView />
  <Toaster
    position="top-center"
    :duration="3000"
    :visible-toasts="3"
    rich-colors
    :toast-options="{ classes: { toast: 'app-toast' } }"
  />
  <ConfirmDialog />
</template>

<style>
/* Toaster must be position:fixed and zero-height so it never affects document flow / scrollbar */
[data-sonner-toaster] {
  position: fixed !important;
  z-index: 9999 !important;
  pointer-events: none;
}
[data-sonner-toaster] > * {
  pointer-events: auto;
}
[data-sonner-toaster][data-y-position="top"] {
  top: 32px !important;
  bottom: auto !important;
}
[data-sonner-toaster][data-x-position="center"] {
  left: 50% !important;
  right: auto !important;
  transform: translateX(-50%);
}
[data-sonner-toaster][data-theme] {
  --width: 380px;
}
.app-toast {
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
}
</style>
