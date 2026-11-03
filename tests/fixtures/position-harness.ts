/** Dev-only integration harness. Uses the real adapter and repositories, never production data. */
import { EpubJsAdapter } from '../../src/infrastructure/epub/EpubJsAdapter';
import { createLocalStore } from '../../src/infrastructure/local-store';
import { PositionResolver } from '../../src/infrastructure/epub/PositionResolver';
import {
  cursorAt,
  cursorForWord,
  type ReadingCursor,
} from '../../src/domain/text-position';
import {
  defaultReaderPreferences,
  type ReaderLocation,
  type ReaderSession,
} from '../../src/domain/reader';
import { PositionPersistenceService } from '../../src/services/position-persistence';
import JSZip from 'jszip';
import EpubCFI from 'epubjs/lib/epubcfi.js';

export interface RoundtripResult {
  target: ReadingCursor;
  selected: ReadingCursor | null;
  afterStyle: ReadingCursor | null;
  restored: ReadingCursor | null;
  handoff: ReadingCursor | null;
  progressBefore: number;
  progressAfter: number;
  framesAfterClose: number;
  errors: string[];
  visibleBefore: boolean;
  visibleAfterStyle: boolean;
  visibleAfterRestore: boolean;
}
const frame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });
export async function seedLegacyTablePosition(): Promise<ReadingCursor> {
  const store = createLocalStore();
  try {
    const snapshot = await store.readLibrary();
    const file = snapshot.files[0]
      ? await store.repositories.bookFiles.get(snapshot.files[0].id)
      : undefined;
    const reading = snapshot.readings[0];
    if (!file?.sha256 || !reading) throw new Error('Missing fixture');
    const index = await store.getDocumentTextIndex(file.id, file.sha256);
    const section = index?.sections[0];
    if (!index || !section) throw new Error('Missing text index');
    const zip = await JSZip.loadAsync(await file.data.arrayBuffer());
    const source = await zip.file(section.path)?.async('string');
    if (!source) throw new Error('Missing XHTML');
    const legacy = new DOMParser().parseFromString(source, 'text/html');
    const text = legacy.querySelector('td')?.firstChild;
    if (!text) throw new Error('Missing table text');
    const range = legacy.createRange();
    range.setStart(text, (text.textContent ?? '').indexOf('Восстановить'));
    range.collapse(true);
    const cfi = new EpubCFI(range, section.cfiBase).toString();
    await store.saveReaderPosition({
      readingId: reading.id,
      bookFileId: file.id,
      cfi,
      progression: 0,
    });
    return cursorAt(
      index,
      section.spineIndex,
      section.text.indexOf('Восстановить'),
    );
  } finally {
    store.close();
  }
}
export async function runPositionRoundtrip(): Promise<RoundtripResult> {
  const store = createLocalStore();
  const adapter = new EpubJsAdapter();
  const host = document.createElement('div');
  host.style.cssText =
    'position:fixed;inset:0;width:320px;height:600px;background:white;z-index:20';
  document.body.append(host);
  let session: ReaderSession | null = null;
  const abort = new AbortController();
  try {
    const snapshot = await store.readLibrary();
    const file = snapshot.files[0]
      ? await store.repositories.bookFiles.get(snapshot.files[0].id)
      : undefined;
    const reading = snapshot.readings[0];
    const source = (await store.repositories.epubIndexes.list())[0];
    if (!file?.sha256 || !reading || !source)
      throw new Error('Missing fixture');
    const index = await store.getDocumentTextIndex(file.id, file.sha256);
    if (!index) throw new Error('Missing DocumentTextIndex');
    const errors: string[] = [];
    const relocations: ReaderLocation[] = [];
    const writer = new PositionPersistenceService(
      store,
      { bookId: file.bookId, fileId: file.id, readingId: reading.id },
      () => undefined,
    );
    const open = (position?: { cursor?: ReadingCursor; cfi: string }) =>
      adapter.openReader({
        host,
        file,
        index: source,
        documentIndex: index,
        cfi: position?.cfi ?? null,
        ...(position?.cursor ? { cursor: position.cursor } : {}),
        signal: abort.signal,
        preferences: { ...defaultReaderPreferences },
        onLocation: (location) => {
          relocations.push(location);
          writer.push(location);
        },
        onBusy: () => undefined,
        onToggleControls: () => undefined,
        onError: (message) => {
          errors.push(message);
        },
      });
    session = await open();
    const target = cursorForWord(index, 1, 150);
    const visible = () => {
      const iframe = host.querySelector('iframe');
      const doc = iframe?.contentDocument;
      if (!iframe || !doc) return false;
      const resolver = new PositionResolver(index);
      const range = resolver.toRange(target, doc);
      const token = index.sections
        .find((section) => section.spineIndex === target.spineIndex)
        ?.tokens.find(
          (entry) => entry.start === target.offset && entry.kind === 'word',
        );
      if (!token) return false;
      const end = resolver.toRange(
        cursorAt(index, target.spineIndex, token.end),
        doc,
      );
      range.setEnd(end.startContainer, end.startOffset);
      const frameRect = iframe.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      return Array.from(range.getClientRects()).some(
        (rect) =>
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom + frameRect.top > hostRect.top &&
          rect.top + frameRect.top < hostRect.bottom &&
          rect.right + frameRect.left > hostRect.left &&
          rect.left + frameRect.left < hostRect.right,
      );
    };
    await session.goToCursor(target);
    const visibleBefore = visible();
    const doc = host.querySelector('iframe')?.contentDocument;
    if (!doc) throw new Error('Missing rendition DOM');
    const resolver = new PositionResolver(index);
    const selectedRange = resolver.toRange(target, doc);
    const token = index.sections
      .find((section) => section.spineIndex === 1)
      ?.tokens.find(
        (entry) => entry.start === target.offset && entry.kind === 'word',
      );
    if (!token) throw new Error('Missing word token');
    const end = resolver.toRange(cursorAt(index, 1, token.end), doc);
    selectedRange.setEnd(end.startContainer, end.startOffset);
    const selection = doc.defaultView?.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(selectedRange);
    const selected = session.getSelectionCursor();
    selection?.removeAllRanges();
    const progressBefore = relocations.at(-1)?.progression ?? -1;
    await session.setPreferences({
      ...defaultReaderPreferences,
      fontSize: 28,
      margin: 32,
      mode: 'scroll',
    });
    const afterStyle = session.getCursor();
    const visibleAfterStyle = visible();
    const progressAfter = relocations.at(-1)?.progression ?? -1;
    await writer.flush();
    const saved = (await store.repositories.positions.list()).find(
      (position) =>
        position.readingId === reading.id && position.bookFileId === file.id,
    );
    if (!saved) throw new Error('Missing persisted position');
    session.destroy();
    await frame();
    await frame();
    await frame();
    session = await open(saved);
    const restored = session.getCursor();
    const visibleAfterRestore = visible();
    // Mode-independent payload. No RSVP implementation is mounted by this test.
    const handoff = JSON.parse(JSON.stringify(target)) as ReadingCursor;
    await session.goToCursor(handoff);
    const returned = session.getCursor();
    session.destroy();
    session = null;
    await frame();
    await frame();
    await frame();
    await writer.flush();
    return {
      target,
      selected,
      afterStyle,
      restored,
      handoff: returned,
      progressBefore,
      progressAfter,
      framesAfterClose: host.querySelectorAll('iframe').length,
      errors,
      visibleBefore,
      visibleAfterStyle,
      visibleAfterRestore,
    };
  } finally {
    abort.abort();
    session?.destroy();
    host.remove();
    store.close();
  }
}
