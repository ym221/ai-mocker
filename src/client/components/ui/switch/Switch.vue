<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { SwitchRoot, SwitchThumb, type SwitchRootEmits, type SwitchRootProps } from 'reka-ui'
import { useForwardPropsEmits } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = defineProps<SwitchRootProps & { class?: HTMLAttributes['class'] }>()
const emits = defineEmits<SwitchRootEmits>()

const delegatedProps = useForwardPropsEmits(props, emits)
</script>

<template>
  <SwitchRoot
    v-bind="delegatedProps"
    :class="cn(
      'peer data-[state=checked]:bg-primary data-[state=unchecked]:bg-input focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-2 dark:data-[state=unchecked]:bg-input/80 inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full border border-transparent shadow-sm transition-all outline-none disabled:cursor-not-allowed disabled:opacity-50',
      props.class,
    )"
  >
    <SwitchThumb
      :class="cn(
        'bg-background pointer-events-none block h-4 w-4 rounded-full ring-0 transition-transform data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-[-2px]',
      )"
    />
  </SwitchRoot>
</template>
