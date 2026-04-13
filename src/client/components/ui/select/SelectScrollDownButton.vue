<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { SelectScrollDownButton, type SelectScrollDownButtonProps } from 'reka-ui'
import { ChevronDown } from 'lucide-vue-next'
import { cn } from '@/lib/utils'

const props = defineProps<SelectScrollDownButtonProps & { class?: HTMLAttributes['class'] }>()
</script>

<template>
  <SelectScrollDownButton
    v-bind="{ ...props, class: undefined }"
    :class="cn('flex cursor-default items-center justify-center py-1', props.class)"
  >
    <slot>
      <ChevronDown class="size-4" />
    </slot>
  </SelectScrollDownButton>
</template>
