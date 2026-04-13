<script setup lang="ts">
import { RouterView } from 'vue-router';
import { Toaster } from 'vue-sonner';
</script>

<template>
  <RouterView />
  <Toaster position="top-right" :duration="3000" />
</template>
