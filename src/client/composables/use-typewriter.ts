import { ref, watch, onBeforeUnmount } from 'vue';

interface Options {
  /** Reactive source text (growing). */
  source: () => string;
  /** Whether typewriter effect is active. When false, displayed = full source. */
  enabled: () => boolean;
  /** Flip to true when streaming done → flush remaining queue immediately. */
  done: () => boolean;
}

const TICK_MS = 15;

/** Decide chars-per-tick based on backlog length. */
function charsPerTick(backlog: number): number {
  if (backlog > 200) return 10;
  if (backlog > 20) return 3;
  return 1;
}

/**
 * Two-layer buffer: push raw deltas → queue; rAF-paced drain → displayed.
 * Adaptive speed based on queue depth. Flushes immediately on done.
 */
export function useTypewriter(opts: Options) {
  const displayed = ref('');
  let queue = '';
  let committed = 0;          // length of `source()` we've consumed into queue
  let rafHandle: number | null = null;
  let timerHandle: ReturnType<typeof setTimeout> | null = null;

  function scheduleTick() {
    if (rafHandle != null || timerHandle != null) return;
    // rAF for throttling; but rAF stops in background tab → fallback to setTimeout
    if (typeof requestAnimationFrame === 'function') {
      rafHandle = requestAnimationFrame(() => {
        rafHandle = null;
        timerHandle = setTimeout(tick, TICK_MS);
      });
    } else {
      timerHandle = setTimeout(tick, TICK_MS);
    }
  }

  function tick() {
    timerHandle = null;
    if (queue.length === 0) return;
    const n = Math.min(charsPerTick(queue.length), queue.length);
    displayed.value += queue.slice(0, n);
    queue = queue.slice(n);
    if (queue.length > 0) scheduleTick();
  }

  function flushAll() {
    if (queue.length > 0) {
      displayed.value += queue;
      queue = '';
    }
    if (rafHandle != null) { cancelAnimationFrame(rafHandle); rafHandle = null; }
    if (timerHandle != null) { clearTimeout(timerHandle); timerHandle = null; }
  }

  function reset() {
    flushAll();
    displayed.value = '';
    committed = 0;
  }

  // Watch source growth
  watch(
    () => opts.source(),
    (curr) => {
      curr = curr || '';
      if (!opts.enabled()) {
        // Not streaming: sync immediately
        flushAll();
        displayed.value = curr;
        committed = curr.length;
        return;
      }
      // Streaming path
      if (curr.length < committed || !curr.startsWith(displayed.value)) {
        // Content truncated or diverged → reset to current state
        reset();
        queue = curr;
        committed = curr.length;
        scheduleTick();
        return;
      }
      // Normal: append diff
      if (curr.length > committed) {
        const diff = curr.slice(committed);
        // Large batch (>300 chars at once) = historical replay, not live stream → show instantly
        if (diff.length > 300) {
          flushAll();
          displayed.value = curr;
          committed = curr.length;
          return;
        }
        queue += diff;
        committed = curr.length;
        scheduleTick();
      }
    },
    { immediate: true },
  );

  // Watch done → flush remaining immediately
  watch(
    () => opts.done(),
    (d) => {
      if (d) flushAll();
    },
  );

  // Watch enabled flip → sync
  watch(
    () => opts.enabled(),
    (e) => {
      if (!e) {
        const curr = opts.source() || '';
        flushAll();
        displayed.value = curr;
        committed = curr.length;
      }
    },
  );

  onBeforeUnmount(() => {
    if (rafHandle != null) cancelAnimationFrame(rafHandle);
    if (timerHandle != null) clearTimeout(timerHandle);
  });

  return { displayed };
}
