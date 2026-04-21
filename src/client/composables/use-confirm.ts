import { ref, watch } from 'vue';

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'default' | 'destructive';
}

interface ConfirmState extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

const pendingState = ref<ConfirmState | null>(null);
const open = ref(false);

// Watch open → false to resolve any pending promise as "cancelled".
// This covers all close paths: Escape, outside click, X button, cancel button.
// The state is NOT cleared here so the closing animation still has content to render.
watch(open, (isOpen) => {
  if (!isOpen && pendingState.value) {
    pendingState.value.resolve(false);
    // Defer state cleanup until after reka-ui's exit animation (~200ms)
    setTimeout(() => { pendingState.value = null; }, 250);
  }
});

export function useConfirm() {
  function confirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      pendingState.value = { ...options, resolve };
      open.value = true;
    });
  }

  function handleConfirm() {
    if (pendingState.value) {
      pendingState.value.resolve(true);
      // Prevent the watch from resolving again with false
      pendingState.value = null;
    }
    open.value = false;
  }

  function handleCancel() {
    // Just close — the watch(open) will resolve with false
    open.value = false;
  }

  return {
    confirm,
    state: pendingState,
    open,
    handleConfirm,
    handleCancel,
  };
}
