import { afterEach, expect, it, vi } from 'vitest';
import { operationDeadline } from '../src/services/operation-deadline';
afterEach(() => vi.useRealTimers());
it('settles a hung engine with a readable error and releases its timer', async () => {
  vi.useFakeTimers();
  const operation = operationDeadline(
    new Promise<never>(() => undefined),
    new AbortController().signal,
    15000,
    'Не удалось открыть книгу',
  );
  const rejected = expect(operation).rejects.toThrow(
    'Не удалось открыть книгу',
  );
  await vi.advanceTimersByTimeAsync(15000);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});
it('cancels promptly and ignores a late engine result', async () => {
  vi.useFakeTimers();
  const abort = new AbortController();
  let complete: ((value: number) => void) | undefined;
  const operation = operationDeadline(
    new Promise<number>((resolve) => {
      complete = resolve;
    }),
    abort.signal,
    15000,
    'timeout',
  );
  const rejected = expect(operation).rejects.toThrow('Открытие отменено');
  abort.abort();
  complete?.(42);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});
it('does not keep a watchdog alive after successful opening', async () => {
  vi.useFakeTimers();
  expect(
    await operationDeadline(
      Promise.resolve(42),
      new AbortController().signal,
      15000,
      'timeout',
    ),
  ).toBe(42);
  expect(vi.getTimerCount()).toBe(0);
});
