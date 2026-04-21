import { reactive, onBeforeUnmount, watch, type Component } from 'vue';

export interface PageHeaderConfig {
  title: string;
  description?: string;
  meta?: string;        // small meta text shown beside description (e.g. basePath)
  back?: string;        // optional back-link route path
  actionsComponent?: Component | null;
}

const state = reactive<PageHeaderConfig>({
  title: '',
  description: '',
  meta: '',
  back: undefined,
  actionsComponent: null,
});

export function usePageHeaderState() {
  return state;
}

/**
 * Set page header from a page component. Auto-clears on unmount.
 * Accepts plain config or a getter (for reactive deps like route params).
 */
export function usePageHeader(configOrGetter: PageHeaderConfig | (() => PageHeaderConfig)) {
  const apply = (cfg: PageHeaderConfig) => {
    state.title = cfg.title || '';
    state.description = cfg.description || '';
    state.meta = cfg.meta || '';
    state.back = cfg.back;
    state.actionsComponent = cfg.actionsComponent ?? null;
  };

  if (typeof configOrGetter === 'function') {
    const stop = watch(configOrGetter as () => PageHeaderConfig, apply, { immediate: true, deep: true });
    onBeforeUnmount(() => {
      stop();
      apply({ title: '' });
    });
  } else {
    apply(configOrGetter);
    onBeforeUnmount(() => apply({ title: '' }));
  }
}
