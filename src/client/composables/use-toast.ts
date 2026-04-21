/**
 * 统一 Toast 封装 — 业务代码应只从这里导入 toast。
 *
 * 好处：
 * - 未来切换底层实现（sonner → naive-ui/element）只改此文件
 * - 统一 duration、样式、位置策略
 * - 保留与 sonner 同名方法，便于渐进替换
 */
import { toast as sonner } from 'vue-sonner';

export interface ToastOptions {
  description?: string;
  duration?: number;
}

const DEFAULT_DURATION = 3000;
const DEFAULT_ERROR_DURATION = 5000;

export const toast = {
  success(message: string, opts: ToastOptions = {}) {
    return sonner.success(message, {
      description: opts.description,
      duration: opts.duration ?? DEFAULT_DURATION,
    });
  },
  error(message: string, opts: ToastOptions = {}) {
    return sonner.error(message, {
      description: opts.description,
      duration: opts.duration ?? DEFAULT_ERROR_DURATION,
    });
  },
  info(message: string, opts: ToastOptions = {}) {
    return sonner.info(message, {
      description: opts.description,
      duration: opts.duration ?? DEFAULT_DURATION,
    });
  },
  warning(message: string, opts: ToastOptions = {}) {
    return sonner.warning(message, {
      description: opts.description,
      duration: opts.duration ?? DEFAULT_DURATION,
    });
  },
  /** Neutral toast (no icon/color) */
  message(message: string, opts: ToastOptions = {}) {
    return sonner(message, {
      description: opts.description,
      duration: opts.duration ?? DEFAULT_DURATION,
    });
  },
  dismiss(id?: string | number) {
    return sonner.dismiss(id);
  },
};

export function useToast() {
  return toast;
}
