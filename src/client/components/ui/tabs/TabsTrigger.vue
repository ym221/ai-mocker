<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { TabsTrigger, type TabsTriggerProps } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = defineProps<TabsTriggerProps & { class?: HTMLAttributes['class'] }>()
</script>

<template>
  <TabsTrigger
    v-bind="{ ...props, class: undefined }"
    :class="cn(
      'data-[state=active]:bg-background data-[state=active]:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-sm font-medium transition-all outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:shadow-sm [&_svg]:pointer-events-none [&_svg]:shrink-0',
      props.class,
    )"
  >
    <slot />
  </TabsTrigger>
</template>
