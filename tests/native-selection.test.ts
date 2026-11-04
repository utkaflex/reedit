// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeNativeSelection } from '../src/infrastructure/epub/native-selection';

afterEach(() => {
  vi.useRealTimers();
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});
describe('наблюдение нативного выделения', () => {
  it('не считает скрытое состояние iframe сворачиванием видимого приложения', () => {
    vi.useFakeTimers();
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    if (!doc || !win) throw Error('Missing frame');
    Object.defineProperty(doc, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
    doc.body.textContent = 'Сохранённая цитата';
    const range = doc.createRange();
    const text = doc.body.firstChild;
    if (!text) throw Error('Missing text');
    range.setStart(text, 0);
    range.setEnd(text, 11);
    win.getSelection()?.addRange(range);
    const notify = vi.fn<(range: Range | null) => void>();
    const stop = observeNativeSelection(doc, win, notify);
    try {
      vi.advanceTimersByTime(300);
      expect(notify.mock.calls[0]?.[0]?.toString()).toBe('Сохранённая');
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
      });
      win.getSelection()?.removeAllRanges();
      vi.advanceTimersByTime(600);
      expect(notify).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        configurable: true,
      });
    }
  });
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
