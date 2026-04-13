<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { DropdownMenuItem, type DropdownMenuItemProps } from 'reka-ui'
import { cn } from '@/lib/utils'

interface Props extends DropdownMenuItemProps {
  class?: HTMLAttributes['class']
  inset?: boolean
}

const props = defineProps<Props>()
</script>

<template>
  <DropdownMenuItem
    v-bind="{ ...props, class: undefined }"
    :class="cn(
      'focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:!text-destructive [&_svg:not([class*=text-])]:text-muted-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
      inset && 'pl-8',
      props.class,
    )"
  >
    <slot />
  </DropdownMenuItem>
</template>
