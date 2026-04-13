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
    :class="cn('flex size-9 items-center justify-center', props.class)"
  >
    <slot>
      <Ellipsis class="size-4" />
    </slot>
    <span class="sr-only">More pages</span>
  </PaginationEllipsis>
</template>
