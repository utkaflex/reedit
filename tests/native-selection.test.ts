// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeNativeSelection } from '../src/infrastructure/epub/native-selection';

afterEach(() => {
  vi.useRealTimers();
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});
describe('наблюдение нативного выделения', () => {
  it('снимает диапазон без selectionchange, не дублирует и освобождает таймеры', () => {
    vi.useFakeTimers();
    const block = (event: Event) => {
      event.stopImmediatePropagation();
    };
    document.addEventListener('selectionchange', block, true);
    document.body.textContent = 'Русская цитата — точный фрагмент.';
    const notify = vi.fn<(range: Range | null) => void>();
    const stop = observeNativeSelection(document, window, notify);
    try {
      const text = document.body.firstChild;
      if (!text) throw Error('No text');
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 14);
      window.getSelection()?.addRange(range);
      vi.advanceTimersByTime(299);
      expect(notify).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0]?.[0]?.toString()).toBe('Русская цитата');
      vi.advanceTimersByTime(900);
      expect(notify).toHaveBeenCalledTimes(1);
      window.getSelection()?.removeAllRanges();
      vi.advanceTimersByTime(300);
      expect(notify).toHaveBeenLastCalledWith(null);
      document.dispatchEvent(new Event('touchend'));
      stop();
      vi.advanceTimersByTime(1000);
      expect(notify).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      stop();
      document.removeEventListener('selectionchange', block, true);
    }
  });
});
