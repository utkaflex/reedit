import type Book from 'epubjs/types/book';
import Rendition from 'epubjs/lib/rendition.js';
import type { RenditionOptions } from 'epubjs/types/rendition';
import type Contents from 'epubjs/types/contents';
import { operationDeadline } from '../../services/operation-deadline';

export interface PageRun {
  spineIndex: number;
  first: number;
  count: number;
}

export function viewportPages(viewport: HTMLElement) {
  const vertical =
    viewport.scrollWidth <= viewport.clientWidth &&
    viewport.scrollHeight > viewport.clientHeight;
  const extent = vertical ? viewport.clientHeight : viewport.clientWidth;
  const offset = vertical ? viewport.scrollTop : Math.abs(viewport.scrollLeft);
  const size = vertical ? viewport.scrollHeight : viewport.scrollWidth;
  const count = Math.max(1, Math.ceil(size / Math.max(1, extent)));
  return {
    number: Math.min(count, Math.round(offset / Math.max(1, extent)) + 1),
    count,
    move(number: number) {
      const target = (number - 1) * extent;
      if (vertical) viewport.scrollTop = target;
      else
        viewport.scrollLeft =
          getComputedStyle(viewport).direction === 'rtl' ? -target : target;
    },
  };
}

/** Use the same column engine and resources as the visible reader. */
export async function measureBookPages(
  book: Book,
  sections: readonly number[],
  settings: RenditionOptions,
  style: (contents: Contents) => void,
  signal: AbortSignal,
): Promise<PageRun[]> {
  const shell = document.createElement('div');
  shell.setAttribute('aria-hidden', 'true');
  shell.inert = true;
  shell.style.cssText =
    'position:fixed;left:-20000px;top:0;opacity:0;pointer-events:none';
  const host = document.createElement('div');
  shell.attachShadow({ mode: 'closed' }).append(host);
  document.body.append(shell);
  // The live rendition already registered the book-wide identifier hook.
  const hooks = book.spine.hooks.content;
  const original = new Set<unknown>(hooks.list());
  const rendition = new Rendition(book, settings);
  for (const hook of hooks.list() as unknown[])
    if (typeof hook === 'function' && !original.has(hook))
      hooks.deregister(hook);
  const measured = new Map<number, Contents>();
  rendition.hooks.content.register((contents: Contents) => {
    style(contents);
    measured.clear();
    measured.set(contents.sectionIndex, contents);
  });
  const runs: PageRun[] = [];
  let first = 1;
  try {
    await rendition.attachTo(host);
    for (const spineIndex of sections) {
      signal.throwIfAborted();
      await operationDeadline(
        rendition.display(spineIndex),
        signal,
        8000,
        'Не удалось измерить страницы раздела.',
      );
      const viewport = host.querySelector<HTMLElement>('.epub-container');
      const contents = measured.get(spineIndex);
      if (!viewport || !contents) throw new Error('Раздел ещё не готов.');
      await operationDeadline(
        Promise.all([
          contents.document.fonts.ready,
          ...Array.from(contents.document.images, (image) => {
            image.loading = 'eager';
            return image.decode().catch(() => undefined);
          }),
        ]),
        signal,
        5000,
        'Раздел ещё не готов.',
      );
      // The view's own expansion uses the same textWidth/column-width ratio.
      const count = Math.max(
        viewportPages(viewport).count,
        Math.ceil(contents.textWidth() / Math.max(1, viewport.clientWidth)),
      );
      runs.push({ spineIndex, first, count });
      first += count;
    }
    return runs;
  } finally {
    rendition.destroy();
    shell.remove();
  }
}
