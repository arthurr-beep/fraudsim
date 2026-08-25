/**
 * Sleep utility — abort-aware.
 *
 * Used by scenarios to space out attack attempts. Respects AbortSignal
 * so scenarios cancel promptly when the user aborts.
 */

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new Error('Aborted'));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    };

    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}
