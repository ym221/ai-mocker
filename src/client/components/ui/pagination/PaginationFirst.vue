<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { PaginationFirst, type PaginationFirstProps } from 'reka-ui'
import { ChevronsLeft } from 'lucide-vue-next'
import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'

const props = defineProps<PaginationFirstProps & { class?: HTMLAttributes['class'] }>()
</script>

<template>
  <PaginationFirst
    v-bind="{ ...props, class: undefined }"
    :class="cn(
      buttonVariants({ variant: 'outline' }),
      'h-9 w-9 p-0',
      props.class,
    )"
  >
    <slot>
      <ChevronsLeft class="h-4 w-4" />
    </slot>
  </PaginationFirst>
</template>
