<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { PaginationPrev, type PaginationPrevProps } from 'reka-ui'
import { ChevronLeft } from 'lucide-vue-next'
import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'

const props = defineProps<PaginationPrevProps & { class?: HTMLAttributes['class'] }>()
</script>

<template>
  <PaginationPrev
    v-bind="{ ...props, class: undefined }"
    :class="cn(
      buttonVariants({ variant: 'outline' }),
      'h-9 w-9 p-0',
      props.class,
    )"
  >
    <slot>
      <ChevronLeft class="h-4 w-4" />
    </slot>
  </PaginationPrev>
</template>
