<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import {
  DropdownMenuCheckboxItem,
  type DropdownMenuCheckboxItemEmits,
  type DropdownMenuCheckboxItemProps,
  DropdownMenuItemIndicator,
  useForwardPropsEmits,
} from 'reka-ui'
import { Check } from 'lucide-vue-next'
import { cn } from '@/lib/utils'

const props = defineProps<DropdownMenuCheckboxItemProps & { class?: HTMLAttributes['class'] }>()
const emits = defineEmits<DropdownMenuCheckboxItemEmits>()

const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <DropdownMenuCheckboxItem
    v-bind="{ ...forwarded, class: undefined }"
    :class="cn(
      'focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
      props.class,
    )"
  >
    <span class="pointer-events-none absolute left-2 flex h-3 w-3.5 items-center justify-center">
      <DropdownMenuItemIndicator>
        <Check class="h-4 w-4" />
      </DropdownMenuItemIndicator>
    </span>
    <slot />
  </DropdownMenuCheckboxItem>
</template>
