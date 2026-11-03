/** Bound an engine promise that may never reject; always release timer/listener. */
export function operationDeadline<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  milliseconds: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancelled);
    };
    const cancelled = () => {
      finish();
      reject(new DOMException('Открытие отменено', 'AbortError'));
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error(message));
    }, milliseconds);
    signal.addEventListener('abort', cancelled, { once: true });
    if (signal.aborted) cancelled();
    void promise.then(
      (value) => {
        finish();
        resolve(value);
      },
      (error: unknown) => {
        finish();
        reject(error instanceof Error ? error : new Error(message));
      },
    );
  });
}
