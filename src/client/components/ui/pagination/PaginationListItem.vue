<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { PaginationListItem, type PaginationListItemProps } from 'reka-ui'
import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'

const props = defineProps<PaginationListItemProps & { class?: HTMLAttributes['class'] }>()
</script>

<template>
  <PaginationListItem
    v-bind="{ ...props, class: undefined }"
    :class="cn(
      buttonVariants({ variant: 'outline' }),
      'size-9 p-0',
      props.class,
      'data-[selected]:bg-accent data-[selected]:text-accent-foreground',
    )"
  >
    <slot />
  </PaginationListItem>
</template>
