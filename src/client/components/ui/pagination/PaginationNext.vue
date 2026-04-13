<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { PaginationNext, type PaginationNextProps } from 'reka-ui'
import { ChevronRight } from 'lucide-vue-next'
import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'

const props = defineProps<PaginationNextProps & { class?: HTMLAttributes['class'] }>()
</script>

<template>
  <PaginationNext
    v-bind="{ ...props, class: undefined }"
    :class="cn(
      buttonVariants({ variant: 'outline' }),
      'h-9 w-9 p-0',
      props.class,
    )"
  >
    <slot>
      <ChevronRight class="h-4 w-4" />
    </slot>
  </PaginationNext>
</template>
