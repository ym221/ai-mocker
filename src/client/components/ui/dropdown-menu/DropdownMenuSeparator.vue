<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { DropdownMenuSeparator, type DropdownMenuSeparatorProps } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = defineProps<DropdownMenuSeparatorProps & { class?: HTMLAttributes['class'] }>()
</script>

<template>
  <DropdownMenuSeparator
    v-bind="{ ...props, class: undefined }"
    :class="cn('bg-muted -mx-1 my-1 h-px', props.class)"
  />
</template>
