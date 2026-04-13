<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { TabsContent, type TabsContentProps } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = defineProps<TabsContentProps & { class?: HTMLAttributes['class'] }>()
</script>

<template>
  <TabsContent
    v-bind="{ ...props, class: undefined }"
    :class="cn(
      'focus-visible:border-ring focus-visible:ring-ring/50 mt-2 outline-none focus-visible:ring-2',
      props.class,
    )"
  >
    <slot />
  </TabsContent>
</template>
