/** Read-only fallback for WebKit selection handles and delayed/missing events. */
export function observeNativeSelection(
  doc: Document,
  win: Window,
  notify: (range: Range | null) => void,
): () => void {
  const abort = new AbortController();
  let previous: Range | null = null;
  let delayed: ReturnType<typeof setTimeout> | null = null;
  const sample = () => {
    if (doc.visibilityState === 'hidden') return;
    const selection = win.getSelection();
    const range =
      selection && !selection.isCollapsed && selection.rangeCount
        ? selection.getRangeAt(0)
        : null;
    if (
      range &&
      previous &&
      range.startContainer === previous.startContainer &&
      range.startOffset === previous.startOffset &&
      range.endContainer === previous.endContainer &&
      range.endOffset === previous.endOffset
    )
      return;
    if (!range && !previous) return;
    previous = range?.cloneRange() ?? null;
    notify(previous?.cloneRange() ?? null);
  };
  const afterNativeMenu = () => {
    sample();
    if (delayed) clearTimeout(delayed);
    delayed = setTimeout(sample, 120);
  };
  doc.addEventListener('selectionchange', sample, { signal: abort.signal });
  for (const name of [
    'pointerup',
    'pointercancel',
    'touchend',
    'keyup',
    'contextmenu',
  ])
    doc.addEventListener(name, afterNativeMenu, {
      passive: true,
      signal: abort.signal,
    });
  // Also catches handle updates when no selection event reaches the adapter.
  // Empty/unchanged ranges never run the DOM/CFI resolver.
  const fallback = setInterval(sample, 300);
  return () => {
    abort.abort();
    clearInterval(fallback);
    if (delayed) clearTimeout(delayed);
    previous = null;
  };
}
