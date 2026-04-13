<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { PaginationLast, type PaginationLastProps } from 'reka-ui'
import { ChevronsRight } from 'lucide-vue-next'
import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'

const props = defineProps<PaginationLastProps & { class?: HTMLAttributes['class'] }>()
</script>

<template>
  <PaginationLast
    v-bind="{ ...props, class: undefined }"
    :class="cn(
      buttonVariants({ variant: 'outline' }),
      'size-9 p-0',
      props.class,
    )"
  >
    <slot>
      <ChevronsRight class="size-4" />
    </slot>
  </PaginationLast>
</template>
