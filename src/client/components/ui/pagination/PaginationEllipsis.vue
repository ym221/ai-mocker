<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { PaginationEllipsis, type PaginationEllipsisProps } from 'reka-ui'
import { Ellipsis } from 'lucide-vue-next'
import { cn } from '@/lib/utils'

const props = defineProps<PaginationEllipsisProps & { class?: HTMLAttributes['class'] }>()
</script>

<template>
  <PaginationEllipsis
    v-bind="{ ...props, class: undefined }"
    :class="cn('flex h-9 w-9 items-center justify-center', props.class)"
  >
    <slot>
      <Ellipsis class="h-4 w-4" />
    </slot>
    <span class="sr-only">More pages</span>
  </PaginationEllipsis>
</template>
