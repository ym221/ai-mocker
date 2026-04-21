<script setup lang="ts">
import { useConfirm } from '@/composables/use-confirm';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

const { state, open, handleConfirm, handleCancel } = useConfirm();
</script>

<template>
  <!--
    No extra event handlers on DialogContent — reka-ui handles Escape / outside-click natively
    by toggling `open` to false. The watch(open) in use-confirm resolves the Promise.
    State is kept alive during the exit animation (deferred cleanup via setTimeout).
  -->
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-[420px] confirm-dialog-content" :class="{ 'pointer-events-auto': open }">
      <template v-if="state">
        <DialogHeader>
          <DialogTitle class="text-base font-semibold">{{ state.title }}</DialogTitle>
          <DialogDescription
            v-if="state.description"
            class="text-sm text-muted-foreground whitespace-pre-line mt-1.5"
          >
            {{ state.description }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter class="mt-5 gap-2">
          <Button
            variant="outline"
            size="sm"
            @click="handleCancel"
            data-testid="confirm-cancel"
          >
            {{ state.cancelText || '取消' }}
          </Button>
          <Button
            :variant="state.variant === 'destructive' ? 'destructive' : 'default'"
            size="sm"
            @click="handleConfirm"
            data-testid="confirm-ok"
          >
            {{ state.confirmText || '确定' }}
          </Button>
        </DialogFooter>
      </template>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
/* Smooth scale + fade for confirm dialog */
.confirm-dialog-content {
  animation-duration: 150ms !important;
}
</style>
