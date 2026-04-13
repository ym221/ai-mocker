<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { SelectSeparator, type SelectSeparatorProps } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = defineProps<SelectSeparatorProps & { class?: HTMLAttributes['class'] }>()
</script>

<template>
  <SelectSeparator
    v-bind="{ ...props, class: undefined }"
    :class="cn('bg-muted -mx-1 my-1 h-px', props.class)"
  />
</template>
