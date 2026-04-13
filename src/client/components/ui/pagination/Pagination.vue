<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { PaginationRoot, type PaginationRootEmits, type PaginationRootProps, useForwardPropsEmits } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = withDefaults(defineProps<PaginationRootProps & { class?: HTMLAttributes['class'] }>(), {
  showEdges: true,
})
const emits = defineEmits<PaginationRootEmits>()

const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <PaginationRoot
    v-bind="{ ...forwarded, class: undefined }"
    v-slot="{ page }"
    :class="cn('mx-auto flex w-full justify-center', props.class)"
  >
    <slot :page="page" />
  </PaginationRoot>
</template>
