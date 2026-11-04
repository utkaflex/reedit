import {
  anchorText,
  contentIdentity,
  highlightColors,
} from '../../domain/annotations';
import type { Annotation, TextAnchor } from '../../domain/model';
import type { ReaderSelection } from '../../domain/reader';
import type { SpeedDocument } from '../../domain/speed-reading';
import Book from 'epubjs/lib/book.js';
import EpubCFI from 'epubjs/lib/epubcfi.js';
import type Rendition from 'epubjs/types/rendition';
import type { Location } from 'epubjs/types/rendition';
import type Contents from 'epubjs/types/contents';
import type { EpubAdapter } from '../../domain/epub';
import { checkImportCancelled } from '../../domain/epub';
import {
  flattenNavigation,
  readerGesture,
  validReaderPreferences,
  type ReaderLocation,
  type ReaderOpenOptions,
  type ReaderPreferences,
  type ReaderSession,
  type ReaderTarget,
} from '../../domain/reader';
import { ReaderNavigationGate } from '../../services/reader-navigation';
import { resolveReference } from './xml';
import { observeNativeSelection } from './native-selection';
import {
  buildDocumentTextIndex,
  indexTextSection,
  createIndexScheduler,
} from './text-index';
import { prepareTextDocument } from './text-dom';
import { PositionResolver } from './PositionResolver';
import {
  cursorAt,
  cursorSection,
  TEXT_INDEX_VERSION,
  type DocumentTextIndex,
  type ReadingCursor,
} from '../../domain/text-position';
import { ReadingProgressService } from '../../services/reading-progress';
import { PositionPersistenceService } from '../../services/position-persistence';
import { operationDeadline } from '../../services/operation-deadline';

const palette = {
  light: { background: '#fffefa', text: '#252a27' },
  dark: { background: '#191b19', text: '#eeeee6' },
  sepia: { background: '#f1e5cd', text: '#403627' },
};
const csp =
  "default-src 'none'; script-src 'none'; connect-src 'none'; img-src blob: data:; style-src 'unsafe-inline' blob: data:; font-src blob: data:; media-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
// Documents created by a sandbox iframe belong to a different JS realm.
function isDocument(value: unknown): value is Document {
  return (
    typeof value === 'object' &&
    value !== null &&
    'nodeType' in value &&
    value.nodeType === 9 &&
    'createRange' in value &&
    typeof value.createRange === 'function'
  );
}

class EpubReaderSession implements ReaderSession {
  private speedStop: (() => void) | null = null;
  private returnCursor: ReadingCursor | null = null;
  private speedSource: { spineIndex: number; doc: Document } | null = null;
  private speedRange: { start: ReadingCursor; end: ReadingCursor } | null =
    null;
  private speedOverlay: HTMLDivElement | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private highlights: Annotation[] = [];
  private drawnHighlights: string[] = [];
  private book: Book | null = null;
  private rendition: Rendition | null = null;
  private content: Contents | null = null;
  private contentCleanup: (() => void) | null = null;
  private disposed = false;
  private openingBook = false;
  private operations = 0;
  private releaseQueued = false;
  private ready = false;
  private muted = true;
  private latest: Location | null = null;
  private lastConfirmed: ReaderLocation | null = null;
  private preferences: ReaderPreferences;
  private buffer: ArrayBuffer | null = null;
  private textIndex: DocumentTextIndex | null = null;
  private resolver: PositionResolver | null = null;
  private gate = new ReaderNavigationGate();
  private observer: ResizeObserver | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private resizePending = false;
  private motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private motionChanged = () => {
    if (this.content) this.styleContent(this.content);
  };
  private viewportResize = () => {
    if (this.ready && !this.disposed) {
      const size = this.measure();
      if (size.width !== this.size.width || size.height !== this.size.height)
        this.speedStop?.();
      this.muted = true;
      this.scheduleResize();
    }
  };
  private waitCleanup: (() => void) | null = null;
  private size = { width: 0, height: 0 };
  private abort = () => {
    this.destroy();
  };
  private relocated = (location: Location) => {
    if (this.disposed || !location.start.cfi) return;
    this.latest = location;
    if (this.ready && !this.muted) {
      try {
        this.publish(location);
      } catch (error) {
        this.options.onError(
          error instanceof Error
            ? error.message
            : 'Не удалось сопоставить позицию с текстом.',
        );
      }
    }
  };
  constructor(
    private options: ReaderOpenOptions,
    private analyze: EpubAdapter['analyze'],
  ) {
    this.preferences = { ...options.preferences };
  }
  async start(): Promise<ReaderSession> {
    this.operations++;
    this.options.onBusy(true);
    this.options.signal.addEventListener('abort', this.abort, { once: true });
    try {
      const representation = this.options.file.representation;
      const data = representation?.data ?? this.options.file.data;
      this.options.onProgress?.('Проверяем файл книги…');
      const checked = await this.analyze(
        {
          name: representation ? 'converted.epub' : this.options.file.name,
          size: data.size,
          type: 'application/epub+zip',
          arrayBuffer: () => data.arrayBuffer(),
        },
        this.options.signal,
        (message) => this.options.onProgress?.(message),
      );
      if (
        checked.sha256 !==
          (representation?.sha256 ?? this.options.index.sha256) ||
        (representation &&
          representation.sourceSha256 !== this.options.index.sha256) ||
        checked.spine.length !== this.options.index.spine.length ||
        checked.spine.some(
          (item, index) =>
            item.path !== this.options.index.spine[index]?.path ||
            item.linear !== this.options.index.spine[index].linear,
        )
      )
        throw new Error(
          'Оригинал EPUB не соответствует сохранённому индексу. Повторно импортируйте файл.',
        );
      this.buffer = await checked.original.arrayBuffer();
      this.ensureAlive();
      this.options.onProgress?.('Открываем содержимое EPUB…');
      await this.createBook();
      if (!this.textIndex) throw new Error('Текстовый индекс не готов.');
      let restored = PositionPersistenceService.restore(
        this.textIndex,
        this.options.cfi
          ? {
              cfi: this.options.cfi,
              ...(this.options.cursor ? { cursor: this.options.cursor } : {}),
            }
          : undefined,
      );
      if (restored.cfi && !this.options.cursor)
        restored = {
          cfi: restored.cfi,
          cursor: await this.legacyCursor(restored.cfi),
        };
      const initialCfi = restored.cursor
        ? await this.cfiForCursor(restored.cursor)
        : restored.cfi;
      this.options.onProgress?.('Восстанавливаем место и готовим страницу…');
      await this.settle(
        () => this.display(initialCfi ?? undefined),
        initialCfi ?? undefined,
        restored.cursor,
      );
      this.ready = true;
      this.observeResize();
      return this;
    } catch (error) {
      this.destroy();
      throw error;
    } finally {
      this.endOperation();
      if (!this.disposed) this.options.onBusy(false);
    }
  }
  private ensureAlive() {
    checkImportCancelled(this.options.signal);
    if (this.disposed) throw new Error('Читалка закрыта');
  }
  private requireRendition(): Rendition {
    this.ensureAlive();
    if (!this.rendition) throw new Error('Движок чтения не готов');
    return this.rendition;
  }
  private async display(target?: string): Promise<void> {
    await this.requireRendition().display(target);
    this.ensureAlive();
    if (!target || !this.content) return;
    const doc = this.content.document;
    // A freshly scrolled view can clamp its first target before its height expands.
    // Wait for local resource layout, then use the public display API on the same target.
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.options.signal.removeEventListener('abort', cancelled);
      };
      const cancelled = () => {
        cleanup();
        reject(new Error('Читалка закрыта'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error('Не удалось дождаться раскладки EPUB. Повторите переход.'),
        );
      }, 5000);
      this.options.signal.addEventListener('abort', cancelled, { once: true });
      void Promise.all([
        doc.fonts.ready,
        ...Array.from(doc.getElementsByTagName('img'), (image) =>
          image.decode().catch(() => undefined),
        ),
      ]).then(
        () => {
          cleanup();
          resolve();
        },
        (error: unknown) => {
          cleanup();
          reject(
            error instanceof Error ? error : new Error('Ошибка раскладки EPUB'),
          );
        },
      );
    });
    for (let frame = 0; frame < 2; frame++) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
      this.ensureAlive();
    }
    await this.requireRendition().display(target);
  }
  private async createBook(): Promise<void> {
    this.ensureAlive();
    if (!this.buffer) throw new Error('Оригинал EPUB недоступен');
    const book = new Book({
      replacements: 'blobUrl',
      requestMethod: () =>
        Promise.reject(new Error('Сетевые запросы из EPUB запрещены')),
    });
    this.book = book;
    this.openingBook = true;
    try {
      await operationDeadline(
        book.open(this.buffer, 'binary'),
        this.options.signal,
        15000,
        'Не удалось открыть содержимое EPUB за 15 секунд. Попробуйте другое издание или повторите открытие. Книга сохранена.',
      );
      await operationDeadline(
        book.ready,
        this.options.signal,
        15000,
        'Не удалось загрузить структуру книги. Файл сохранён; попробуйте повторить открытие.',
      );
      await book.loaded.resources;
    } finally {
      this.openingBook = false;
    }
    this.ensureAlive();
    if (
      this.options.index.spine.some(
        (entry) =>
          entry.linear &&
          this.options.index.manifest.find((item) => item.path === entry.path)
            ?.mediaType !== 'application/xhtml+xml',
      )
    )
      throw new Error(
        'Эта книга содержит линейные разделы не в XHTML. Читалка не может показать их без пропусков. Оригинал сохранён.',
      );
    if (book.packaging.metadata.layout === 'pre-paginated')
      throw new Error(
        'EPUB с фиксированной раскладкой пока не поддерживается этой читалкой. Оригинал сохранён.',
      );
    book.spine.hooks.content.register((doc: Document) => {
      prepareTextDocument(doc);
      // Applied before serialization / iframe navigation, not after potentially active markup has loaded.
      const head = doc.getElementsByTagName('head')[0] ?? doc.documentElement;
      for (const base of Array.from(doc.getElementsByTagName('base')))
        base.remove();
      const meta = doc.createElementNS('http://www.w3.org/1999/xhtml', 'meta');
      meta.setAttribute('http-equiv', 'Content-Security-Policy');
      meta.setAttribute('content', csp);
      head.insertBefore(meta, head.firstChild);
    });
    if (!this.textIndex) {
      const cached = this.options.documentIndex;
      if (
        cached &&
        cached.bookFileId === this.options.file.id &&
        cached.sha256 === this.options.index.sha256 &&
        cached.algorithmVersion === TEXT_INDEX_VERSION
      )
        this.textIndex = cached;
      else {
        const built = await buildDocumentTextIndex(
          { id: this.options.file.id, sha256: this.options.index.sha256 },
          this.options.index.spine.flatMap((entry, spineIndex) =>
            entry.linear
              ? [
                  {
                    spineIndex,
                    path: entry.path,
                    cfiBase: book.spine.get(spineIndex).cfiBase,
                    load: async () => {
                      const doc = await book.load(
                        book.spine.get(spineIndex).url,
                      );
                      if (!isDocument(doc))
                        throw new Error('Не удалось получить DOM раздела.');
                      return doc;
                    },
                  },
                ]
              : [],
          ),
          this.options.signal,
          undefined,
          (completed, total) =>
            this.options.onProgress?.(
              `Готовим текст: ${String(completed + 1)} из ${String(total)} разделов…`,
            ),
        );
        this.ensureAlive();
        this.textIndex = this.options.onDocumentIndex
          ? await this.options.onDocumentIndex(built)
          : built;
      }
      this.resolver = new PositionResolver(this.textIndex);
    }
    this.ensureAlive();
    const { width, height } = this.measure();
    this.size = { width, height };
    const rendition = book.renderTo(this.options.host, {
      width,
      height,
      manager: 'default',
      method: 'blobUrl',
      flow:
        this.preferences.mode === 'paginated' ? 'paginated' : 'scrolled-doc',
      spread: 'none',
      gap: this.preferences.margin * 2,
      allowScriptedContent: false,
      allowPopups: false,
      snap: false,
      resizeOnOrientationChange: false,
    });
    this.rendition = rendition;
    rendition.on('relocated', this.relocated);
    rendition.hooks.content.register((contents: Contents) => {
      if (this.disposed) return;
      this.contentCleanup?.();
      this.content = contents;
      this.styleContent(contents);
      this.contentCleanup = this.listenToContent(contents);
    });
    await rendition.started;
    this.ensureAlive();
  }
  private measure() {
    return {
      width: Math.max(1, Math.floor(this.options.host.clientWidth)),
      height: Math.max(1, Math.floor(this.options.host.clientHeight)),
    };
  }
  private styleContent(contents: Contents) {
    const { background, text } = palette[this.preferences.theme];
    const font =
      this.preferences.font === 'serif'
        ? "'Iowan Old Style', 'Palatino Linotype', Georgia, serif"
        : "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    let style: Element | null = contents.document.getElementById(
      'reedit-reader-style',
    );
    if (!style) {
      style = contents.document.createElementNS(
        'http://www.w3.org/1999/xhtml',
        'style',
      );
      style.id = 'reedit-reader-style';
      (
        contents.document.querySelector('head') ??
        contents.document.documentElement
      ).append(style);
    }
    style.textContent = `html { background:${background} !important; color:${text} !important; overflow-wrap:anywhere; -webkit-text-size-adjust:100%; } body { font-family:${font} !important; font-size:${String(this.preferences.fontSize)}px !important; line-height:${String(this.preferences.lineHeight)} !important; color:${text} !important; background:${background} !important; text-align:${this.preferences.alignment} !important; padding-top:16px !important; padding-bottom:16px !important; ${this.preferences.mode === 'scroll' ? `padding-left:${String(this.preferences.margin)}px !important;padding-right:${String(this.preferences.margin)}px !important;` : ''} } p,li,blockquote,div { font-family:inherit !important; font-size:1em !important; line-height:inherit !important; color:inherit !important; text-align:inherit !important; } h1,h2,h3,h4,h5,h6 { font-family:inherit !important; line-height:1.3 !important; overflow-wrap:anywhere; break-after:avoid; } p { orphans:2; widows:2; hyphens:auto; -webkit-hyphens:auto; text-align-last:start; word-spacing:normal !important; } h1,h2,h3 { text-align:center !important; font-weight:600; } blockquote { margin-inline:1em; } img,svg,video { max-width:100% !important; height:auto; max-height:90vh; object-fit:contain; } pre { white-space:pre-wrap !important; overflow-wrap:anywhere; } table { max-width:100% !important; table-layout:fixed; } * { box-sizing:border-box; } a { color:inherit; text-decoration:underline; } ::selection { background:rgba(151,169,113,.4); } ${!this.preferences.animations || window.matchMedia('(prefers-reduced-motion: reduce)').matches ? '* { animation:none !important; transition:none !important; scroll-behavior:auto !important; }' : ''}`;
    style.textContent += `body * { font-family:inherit !important; color:inherit !important; background-color:transparent !important; } body span { font-size:inherit !important; line-height:inherit !important; } body pre,body code { font-family:ui-monospace,monospace !important; }`;
    contents.document.documentElement.style.touchAction = 'pan-y pinch-zoom';
    contents.document.body.style.touchAction = 'pan-y pinch-zoom';
    for (const image of contents.document.querySelectorAll<
      HTMLElement | SVGElement
    >('img,svg,video')) {
      image.style.setProperty(
        'max-width',
        `${String(Math.max(1, this.measure().width - this.preferences.margin * 2))}px`,
        'important',
      );
      image.style.setProperty(
        'max-height',
        `${String(Math.max(1, this.measure().height - 32))}px`,
        'important',
      );
    }
    const frame = this.options.host.querySelector('iframe');
    frame?.setAttribute('title', 'Текст книги');
  }
  private chapter(location: Location): string {
    const path = this.options.index.spine[location.start.index]?.path;
    const candidates = flattenNavigation(this.options.index.navigation).filter(
      (item) => item.path === path,
    );
    let title = candidates.find((item) => !item.fragment)?.label ?? '';
    const content = this.content;
    if (content && content.sectionIndex === location.start.index) {
      try {
        const current = content.range(location.start.cfi);
        let nearest: Range | null = null;
        for (const item of candidates) {
          if (!item.fragment) continue;
          const element = content.document.getElementById(item.fragment);
          if (!element) continue;
          const range = content.document.createRange();
          range.selectNodeContents(element);
          if (
            range.compareBoundaryPoints(0, current) <= 0 &&
            (!nearest || range.compareBoundaryPoints(0, nearest) >= 0)
          ) {
            title = item.label;
            nearest = range;
          }
        }
      } catch {
        /* A section-level label remains available when an anchor is outside the mounted document. */
      }
    }
    return title || `Раздел ${String(location.start.index + 1)}`;
  }
  private publish(
    location: Location,
    anchor?: string,
    preserved?: ReadingCursor,
  ) {
    if (this.disposed || !location.start.cfi.startsWith('epubcfi(')) return;
    const item = this.options.index.spine[location.start.index];
    if (!item) return;
    if (!this.textIndex || !this.resolver || !this.content)
      throw new Error('Текстовая позиция ещё недоступна.');
    if (preserved) this.returnCursor = { ...preserved };
    else if (this.returnCursor) {
      const anchor = this.returnCursor;
      const section = cursorSection(this.textIndex, anchor);
      const token = section.tokens.find(
        (token) => token.kind === 'word' && token.end > anchor.offset,
      );
      if (
        token &&
        !this.speedRects(
          this.returnCursor,
          cursorAt(this.textIndex, section.spineIndex, token.end),
        ).length
      )
        this.returnCursor = null;
    }
    const cursor =
      preserved ??
      (this.returnCursor?.spineIndex === this.content.sectionIndex
        ? this.returnCursor
        : null) ??
      this.resolver.fromCfi(
        anchor ?? location.start.cfi,
        this.content.document,
      );
    cursorSection(this.textIndex, cursor);
    if (cursor.spineIndex !== this.content.sectionIndex)
      throw new Error('Отображаемый раздел не совпадает с текстовой позицией.');
    const cfi = this.resolver.toCfi(cursor, this.content.document);
    const result: ReaderLocation = {
      cfi,
      cursor,
      path: item.path,
      spineIndex: location.start.index,
      chapter: this.chapter(location),
      progression: new ReadingProgressService(this.textIndex).relative(cursor),
      atStart: location.atStart,
      atEnd: location.atEnd,
    };
    // Engine viewport boundaries, deliberately independent of the sticky restore cursor.
    try {
      const start = this.resolver.fromCfi(
        location.start.cfi,
        this.content.document,
      );
      const end = this.resolver.fromCfi(
        location.end.cfi,
        this.content.document,
      );
      if (start.spineIndex === end.spineIndex && end.offset > start.offset)
        result.visible = { start, end };
    } catch {
      /* An unresolved boundary cannot be credited as read text. */
    }
    this.lastConfirmed = result;
    this.drawHighlights();
    this.drawSpeedRange();
    this.options.onLocation(result);
  }
  private async settle(
    action: () => Promise<void>,
    anchor?: string,
    cursor?: ReadingCursor,
  ) {
    this.muted = true;
    try {
      await action();
      this.ensureAlive();
      const rendition = this.requireRendition();
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          rendition.off('relocated', confirmed);
          this.options.signal.removeEventListener('abort', cancelled);
          this.waitCleanup = null;
        };
        const confirmed = (location: Location) => {
          if (!location.start.cfi) return;
          this.latest = location;
          cleanup();
          resolve();
        };
        const cancelled = () => {
          cleanup();
          reject(new Error('Читалка закрыта'));
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(
            new Error(
              'Движок не подтвердил позицию. Закройте и откройте книгу повторно.',
            ),
          );
        }, 10000);
        this.waitCleanup = cancelled;
        this.options.signal.addEventListener('abort', cancelled, {
          once: true,
        });
        rendition.on('relocated', confirmed);
        void rendition.reportLocation().catch((error: unknown) => {
          cleanup();
          reject(
            error instanceof Error
              ? error
              : new Error('Не удалось определить позицию'),
          );
        });
      });
      this.ensureAlive();
      if (this.latest) this.publish(this.latest, anchor, cursor);
    } finally {
      this.muted = false;
    }
  }
  private async command(
    action: () => Promise<void>,
    turn = false,
    anchor?: string,
    cursor?: ReadingCursor,
  ): Promise<boolean> {
    const operation = { started: false };
    try {
      return await this.gate.run(async () => {
        operation.started = true;
        this.options.onBusy(true);
        this.operations++;
        try {
          await this.settle(action, anchor, cursor);
        } finally {
          this.endOperation();
        }
      }, turn);
    } finally {
      if (operation.started && !this.disposed) {
        this.options.onBusy(false);
        if (this.resizePending) {
          this.resizePending = false;
          this.scheduleResize();
        }
      }
    }
  }
  next() {
    this.returnCursor = null;
    if (this.lastConfirmed?.atEnd) return Promise.resolve(false);
    return this.command(() => this.requireRendition().next(), true);
  }
  previous() {
    this.returnCursor = null;
    if (this.lastConfirmed?.atStart) return Promise.resolve(false);
    return this.command(() => this.requireRendition().prev(), true);
  }
  setSpeedInteraction(onStop: (() => void) | null): void {
    this.speedStop = onStop;
    if (onStop) this.returnCursor = null;
  }
  private async sourceForSpeed(spineIndex: number): Promise<Document> {
    this.ensureAlive();
    if (this.content?.sectionIndex === spineIndex) return this.content.document;
    if (this.speedSource?.spineIndex === spineIndex)
      return this.speedSource.doc;
    if (!this.book) throw new Error('Книга закрыта.');
    const doc = await this.book.load(this.book.spine.get(spineIndex).url);
    this.ensureAlive();
    if (!isDocument(doc)) throw new Error('DOM раздела недоступен.');
    prepareTextDocument(doc);
    this.speedSource = { spineIndex, doc };
    return doc;
  }
  getTextIndex(): DocumentTextIndex | null {
    return this.textIndex;
  }
  async getSpeedDocument(): Promise<SpeedDocument> {
    if (!this.textIndex || !this.resolver)
      throw new Error('Текстовый индекс не готов.');
    this.operations++;
    try {
      const paragraphEnds: Record<number, number[]> = {};
      const yieldTask = createIndexScheduler(this.options.signal);
      for (const section of this.textIndex.sections) {
        const doc = await this.sourceForSpeed(section.spineIndex);
        const ends = new Set<number>();
        for (const block of doc.querySelectorAll(
          'p,div,li,h1,h2,h3,h4,h5,h6,blockquote,pre,figcaption,br',
        )) {
          const range = doc.createRange();
          range.selectNodeContents(block);
          range.collapse(false);
          ends.add(this.resolver.fromRange(section.spineIndex, range).offset);
          await yieldTask();
        }
        paragraphEnds[section.spineIndex] = [...ends].sort((a, b) => a - b);
        await yieldTask(true);
      }
      this.ensureAlive();
      return { index: this.textIndex, paragraphEnds };
    } finally {
      this.endOperation();
    }
  }
  async resolveLocation(cursor: ReadingCursor): Promise<ReaderLocation> {
    if (!this.textIndex || !this.resolver)
      throw new Error('Текстовый индекс не готов.');
    this.operations++;
    try {
      const section = cursorSection(this.textIndex, cursor);
      const doc = await this.sourceForSpeed(cursor.spineIndex);
      return {
        cursor: { ...cursor },
        cfi: this.resolver.toCfi(cursor, doc),
        path: section.path,
        spineIndex: cursor.spineIndex,
        chapter:
          flattenNavigation(this.options.index.navigation).find(
            (item) => item.path === section.path,
          )?.label ?? `Раздел ${String(cursor.spineIndex + 1)}`,
        progression: new ReadingProgressService(this.textIndex).relative(
          cursor,
        ),
        atStart: section.start + cursor.offset === 0,
        atEnd: section.start + cursor.offset === this.textIndex.totalCharacters,
      };
    } finally {
      this.endOperation();
    }
  }
  private speedRects(
    start: ReadingCursor,
    end: ReadingCursor,
  ): { left: number; top: number; width: number; height: number }[] {
    if (
      !this.content ||
      this.content.sectionIndex !== start.spineIndex ||
      !this.resolver
    )
      return [];
    const range = this.resolver.rangeBetween(start, end, this.content.document);
    const host = this.options.host.getBoundingClientRect();
    const frame = this.content.window.frameElement?.getBoundingClientRect();
    if (!frame) return [];
    return Array.from(range.getClientRects())
      .filter(
        (rect) =>
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom + frame.top > host.top &&
          rect.top + frame.top < host.bottom &&
          rect.right + frame.left > host.left &&
          rect.left + frame.left < host.right,
      )
      .map((rect) => ({
        left: rect.left + frame.left - host.left,
        top: rect.top + frame.top - host.top,
        width: rect.width,
        height: rect.height,
      }));
  }
  private drawSpeedRange(): void {
    this.speedOverlay?.remove();
    this.speedOverlay = null;
    if (!this.speedRange || this.disposed) return;
    const overlay = document.createElement('div');
    overlay.className = 'speed-highlight-layer';
    overlay.setAttribute('aria-hidden', 'true');
    for (const rect of this.speedRects(
      this.speedRange.start,
      this.speedRange.end,
    )) {
      const mark = document.createElement('span');
      mark.className = 'speed-word-highlight';
      Object.assign(mark.style, {
        left: `${String(rect.left)}px`,
        top: `${String(rect.top)}px`,
        width: `${String(rect.width)}px`,
        height: `${String(rect.height)}px`,
      });
      overlay.append(mark);
    }
    this.options.host.append(overlay);
    this.speedOverlay = overlay;
  }
  async showSpeedRange(
    start: ReadingCursor,
    end: ReadingCursor,
  ): Promise<void> {
    if (!this.textIndex) throw new Error('Текстовый индекс не готов.');
    const section = cursorSection(this.textIndex, start);
    cursorSection(this.textIndex, end);
    if (start.spineIndex !== end.spineIndex || end.offset <= start.offset)
      throw new Error('Некорректный диапазон подсветки.');
    const token = section.tokens.find(
      (token) => token.kind === 'word' && token.end > start.offset,
    );
    const firstEnd = cursorAt(
      this.textIndex,
      start.spineIndex,
      token?.end ?? end.offset,
    );
    const waitStarted = performance.now();
    while (
      (this.gate.busy || this.resizeTimer !== null) &&
      !this.disposed &&
      performance.now() - waitStarted < 5000
    )
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    this.ensureAlive();
    if (!this.speedRects(start, firstEnd).length) {
      if (!(await this.goToCursor(start)))
        throw new Error('Дождитесь завершения изменения страницы и повторите.');
    }
    this.speedRange = { start: { ...start }, end: { ...end } };
    this.drawSpeedRange();
  }
  clearSpeedRange(): void {
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = null;
    this.speedRange = null;
    this.speedOverlay?.remove();
    this.speedOverlay = null;
  }
  async flashCursor(cursor: ReadingCursor): Promise<void> {
    if (!this.textIndex) return;
    const section = cursorSection(this.textIndex, cursor);
    const token = section.tokens.find(
      (token) => token.kind === 'word' && token.end > cursor.offset,
    );
    if (!token) return;
    this.returnCursor = { ...cursor };
    await this.showSpeedRange(
      cursor,
      cursorAt(this.textIndex, cursor.spineIndex, token.end),
    );
    this.flashTimer = setTimeout(() => {
      this.clearSpeedRange();
    }, 1400);
  }
  getCursor(): ReadingCursor | null {
    return !this.disposed && this.lastConfirmed?.cursor
      ? { ...this.lastConfirmed.cursor }
      : null;
  }
  private capture(
    start: ReadingCursor,
    end: ReadingCursor,
  ): ReaderSelection | null {
    if (!this.textIndex || !this.resolver || !this.content) return null;
    const contentId = contentIdentity(this.options.file);
    if (!contentId) return null;
    const section = cursorSection(this.textIndex, start);
    const anchor: TextAnchor = {
      contentId,
      start,
      end,
      before: section.text.slice(Math.max(0, start.offset - 48), start.offset),
      after: section.text.slice(end.offset, end.offset + 48),
    };
    return {
      anchor,
      quote: anchorText(this.textIndex, anchor),
      cfi: this.resolver.rangeCfi(start, end, this.content.document),
    };
  }
  getSelection(): ReaderSelection | null {
    const selection = this.content?.window.getSelection();
    if (
      !selection?.rangeCount ||
      selection.isCollapsed ||
      !this.content ||
      !this.resolver
    )
      return null;
    try {
      const range = selection.getRangeAt(0);
      const finish = range.cloneRange();
      finish.collapse(false);
      const start = this.resolver.fromRange(this.content.sectionIndex, range);
      const end = this.resolver.fromRange(this.content.sectionIndex, finish);
      const result = this.capture(start, end);
      return result?.quote.trim() ? result : null;
    } catch {
      return null;
    }
  }
  getBookmark(): ReaderSelection | null {
    const cursor = this.getCursor();
    return cursor ? this.capture(cursor, cursor) : null;
  }
  goToSaved(anchor: TextAnchor, quote?: string): Promise<boolean> {
    if (
      !this.textIndex ||
      anchor.contentId !== contentIdentity(this.options.file)
    )
      return Promise.reject(
        new Error('Для этой заметки нужен исходный файл того же издания.'),
      );
    try {
      const text = anchorText(this.textIndex, anchor);
      if (quote !== undefined && text !== quote)
        throw new Error('Цитата не совпадает с текстом книги.');
      // Rebuild a canonical CFI from validated offsets; obsolete or malformed stored CFIs are never trusted.
      return this.goToCursor(anchor.start);
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new Error('Повреждённая привязка заметки.'),
      );
    }
  }
  setHighlights(annotations: Annotation[]): void {
    this.highlights = annotations;
    this.drawHighlights();
  }
  private drawHighlights(): void {
    const rendition = this.rendition;
    if (!rendition || !this.content || !this.resolver || !this.textIndex)
      return;
    for (const cfi of this.drawnHighlights)
      rendition.annotations.remove(cfi, 'highlight');
    this.drawnHighlights = [];
    for (const item of this.highlights) {
      const a = item.anchor;
      if (
        !a ||
        a.contentId !== contentIdentity(this.options.file) ||
        a.start.spineIndex !== this.content.sectionIndex
      )
        continue;
      try {
        if (anchorText(this.textIndex, a) !== item.quote) continue;
        const cfi = this.resolver.rangeCfi(
          a.start,
          a.end,
          this.content.document,
        );
        rendition.annotations.highlight(
          cfi,
          {},
          undefined,
          'reedit-highlight',
          {
            fill: highlightColors[item.color ?? 'yellow'].fill,
            'fill-opacity': '0.32',
            'mix-blend-mode': 'normal',
          },
        );
        this.drawnHighlights.push(cfi);
      } catch {
        /* Keep the stored quote visible in lists even when a range cannot be rendered. */
      }
    }
  }
  getSelectionCursor(): ReadingCursor | null {
    const selection = this.content?.window.getSelection();
    if (
      !selection?.rangeCount ||
      selection.isCollapsed ||
      !this.content ||
      !this.resolver ||
      !this.textIndex
    )
      return null;
    const range = selection.getRangeAt(0);
    const cursor = this.resolver.fromRange(this.content.sectionIndex, range);
    const canonical = this.resolver.toRange(cursor, this.content.document);
    const start = range.cloneRange();
    start.collapse(true);
    const section = cursorSection(this.textIndex, cursor);
    return canonical.compareBoundaryPoints(0, start) === 0 &&
      section.tokens.some(
        (token) =>
          token.kind === 'word' &&
          token.start <= cursor.offset &&
          token.end > cursor.offset,
      )
      ? cursor
      : null;
  }
  private async cfiForCursor(cursor: ReadingCursor): Promise<string> {
    if (!this.textIndex || !this.resolver || !this.book)
      throw new Error('Текстовый индекс не готов.');
    cursorSection(this.textIndex, cursor);
    const doc =
      this.content?.sectionIndex === cursor.spineIndex
        ? this.content.document
        : await this.book.load(this.book.spine.get(cursor.spineIndex).url);
    this.ensureAlive();
    if (!isDocument(doc)) throw new Error('DOM раздела недоступен.');
    return this.resolver.toCfi(cursor, doc);
  }
  private async legacyCursor(cfi: string): Promise<ReadingCursor> {
    if (!this.textIndex || !this.book)
      throw new Error('Текстовый индекс не готов.');
    const spineIndex = new EpubCFI(cfi).spinePos;
    const section = this.textIndex.sections.find(
      (entry) => entry.spineIndex === spineIndex,
    );
    if (!section)
      throw new Error('Сохранённый CFI не относится к читаемому spine.');
    const source = await this.book.load(this.book.spine.get(spineIndex).url);
    this.ensureAlive();
    if (!isDocument(source)) throw new Error('Исходный DOM недоступен.');
    // Stage 05 used srcdoc/text-html, which can insert tbody and repair XML markup.
    // Keep the legacy DOM inert: URI attributes do not affect CFI/text, and must not fetch.
    for (const element of source.querySelectorAll('*')) {
      for (const attribute of Array.from(element.attributes)) {
        if (
          ['src', 'srcset', 'href', 'poster', 'data', 'srcdoc'].includes(
            attribute.localName,
          )
        )
          element.removeAttributeNode(attribute);
      }
      if (element.localName === 'style') element.textContent = '';
    }
    const legacyDoc = new DOMParser().parseFromString(
      new XMLSerializer().serializeToString(source),
      'text/html',
    );
    const legacySection = await indexTextSection(
      legacyDoc,
      section,
      createIndexScheduler(this.options.signal),
      this.textIndex.segmentation,
    );
    if (legacySection.text !== section.text)
      throw new Error(
        'Старая HTML-позиция не может быть перенесена без предположений. CFI сохранён; можно явно открыть книгу с начала.',
      );
    const resolver = new PositionResolver({
      ...this.textIndex,
      sections: this.textIndex.sections.map((entry) =>
        entry.spineIndex === spineIndex ? legacySection : entry,
      ),
    });
    return resolver.fromCfi(cfi, legacyDoc);
  }
  goToCursor(cursor: ReadingCursor): Promise<boolean> {
    this.returnCursor = null;
    const target = { ...cursor };
    return this.command(
      async () => {
        await this.display(await this.cfiForCursor(target));
      },
      false,
      undefined,
      target,
    );
  }
  goTo(target: ReaderTarget) {
    this.returnCursor = null;
    const item = this.options.index.manifest.find(
      (entry) => entry.path === target.path,
    );
    if (
      !item ||
      !this.options.index.spine.some(
        (entry) => entry.linear && entry.path === target.path,
      )
    )
      return Promise.reject(new Error('Раздел отсутствует в spine книги.'));
    const spineIndex = this.options.index.spine.findIndex(
      (entry) => entry.path === target.path,
    );
    const href = this.book?.spine.get(spineIndex).href;
    if (!href) return Promise.reject(new Error('Не найден адрес раздела EPUB'));
    return this.command(async () => {
      if (target.fragment) {
        const doc: unknown = await this.book?.load(
          this.book.spine.get(spineIndex).url,
        );
        if (
          !isDocument(doc) ||
          !Array.from(doc.getElementsByTagName('*')).some(
            (element) =>
              element.getAttribute('id') === target.fragment ||
              element.getAttribute('name') === target.fragment,
          )
        )
          throw new Error(
            'Эта внутренняя ссылка в книге повреждена. Продолжайте чтение или выберите раздел из оглавления.',
          );
      }
      await this.display(
        `${href}${target.fragment ? `#${target.fragment}` : ''}`,
      );
    });
  }
  setPreferences(preferences: ReaderPreferences) {
    if (!validReaderPreferences(preferences))
      return Promise.reject(new Error('Некорректные настройки чтения'));
    const cfi = this.lastConfirmed?.cfi;
    return this.command(
      async () => {
        const rebuild =
          preferences.mode !== this.preferences.mode ||
          preferences.margin !== this.preferences.margin;
        this.preferences = { ...preferences };
        if (rebuild) {
          this.releaseBook();
          await this.createBook();
        } else {
          if (this.content) this.styleContent(this.content);
          const { width, height } = this.measure();
          this.requireRendition().resize(width, height);
        }
        await this.display(cfi);
      },
      false,
      cfi,
      this.lastConfirmed?.cursor,
    );
  }
  private scheduleResize() {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      if (this.disposed || !this.ready) return;
      if (this.gate.busy) {
        this.resizePending = true;
        return;
      }
      const size = this.measure();
      if (size.width === this.size.width && size.height === this.size.height) {
        this.muted = false;
        return;
      }
      this.size = size;
      const cfi = this.lastConfirmed?.cfi;
      void this.command(
        async () => {
          if (this.content) this.styleContent(this.content);
          this.requireRendition().resize(size.width, size.height);
          await this.display(cfi);
        },
        false,
        cfi,
        this.lastConfirmed?.cursor,
      ).catch((error: unknown) => {
        if (!this.disposed)
          this.options.onError(
            error instanceof Error
              ? error.message
              : 'Не удалось изменить размер страницы',
          );
      });
    }, 100);
  }
  private observeResize() {
    this.observer = new ResizeObserver(() => {
      this.viewportResize();
    });
    this.observer.observe(this.options.host);
    window.addEventListener('resize', this.viewportResize, { capture: true });
    window.visualViewport?.addEventListener('resize', this.viewportResize);
    this.motion.addEventListener('change', this.motionChanged);
  }
  private listenToContent(contents: Contents): () => void {
    this.options.onSelection?.(null);
    const doc = contents.document;
    const listeners = new AbortController();
    for (const name of ['pointerdown', 'keydown', 'wheel', 'touchmove'])
      doc.addEventListener(name, () => this.options.onInteraction?.(), {
        passive: true,
        signal: listeners.signal,
      });
    const userScroll = () => {
      if (this.speedStop) this.speedStop();
      else this.returnCursor = null;
    };
    doc.addEventListener('wheel', userScroll, {
      passive: true,
      signal: listeners.signal,
    });
    doc.addEventListener('touchmove', userScroll, {
      passive: true,
      signal: listeners.signal,
    });
    const stopSelection = observeNativeSelection(doc, contents.window, () => {
      if (!this.disposed && this.content === contents && !this.speedStop)
        this.options.onSelection?.(this.getSelection());
    });
    const point = (event: PointerEvent) => {
      const frame = contents.window.frameElement?.getBoundingClientRect();
      const host = this.options.host.getBoundingClientRect();
      return {
        x: event.clientX + (frame?.left ?? host.left) - host.left,
        y: event.clientY + (frame?.top ?? host.top) - host.top,
      };
    };
    let start: {
      x: number;
      y: number;
      time: number;
      interactive: boolean;
      selected: boolean;
    } | null = null;
    let multitouch = false;
    const pointers = new Set<number>();
    let tap: ReturnType<typeof setTimeout> | null = null;
    let lastTap = -Infinity;
    const perform = (kind: 'next' | 'previous' | 'toggle' | 'none') => {
      if (kind === 'toggle') this.options.onToggleControls();
      else if (kind !== 'none')
        void this[kind]().catch((error: unknown) => {
          if (!this.disposed)
            this.options.onError(
              error instanceof Error
                ? error.message
                : 'Не удалось перелистнуть',
            );
        });
    };
    doc.addEventListener(
      'pointerdown',
      (event) => {
        if (this.speedStop) {
          this.speedStop();
          start = null;
          return;
        }
        pointers.add(event.pointerId);
        if (pointers.size > 1) {
          multitouch = true;
          start = null;
          if (tap) clearTimeout(tap);
          return;
        }
        const target = event.target;
        const element =
          target && 'nodeType' in target && target.nodeType === 1
            ? (target as Element)
            : null;
        if (event.button !== 0) return;
        start = {
          ...point(event),
          time: performance.now(),
          selected: Boolean(contents.window.getSelection()?.toString()),
          interactive: Boolean(
            element?.closest(
              'a,button,input,textarea,select,[contenteditable]',
            ),
          ),
        };
      },
      { signal: listeners.signal },
    );
    doc.addEventListener(
      'pointerup',
      (event) => {
        pointers.delete(event.pointerId);
        const point = start;
        start = null;
        if (multitouch) {
          if (!pointers.size) multitouch = false;
          return;
        }
        if (!point) return;
        const frame = contents.window.frameElement?.getBoundingClientRect();
        const host = this.options.host.getBoundingClientRect();
        const endX = event.clientX + (frame?.left ?? host.left) - host.left;
        const endY = event.clientY + (frame?.top ?? host.top) - host.top;
        const kind = readerGesture({
          ...point,
          endX,
          endY,
          duration: performance.now() - point.time,
          width: this.options.host.clientWidth,
          selected:
            point.selected ||
            Boolean(contents.window.getSelection()?.toString()),
          mode: this.preferences.mode,
          rtl:
            contents.window.getComputedStyle(contents.document.body)
              .direction === 'rtl',
        });
        if (Math.abs(endX - point.x) >= 48 || event.pointerType === 'mouse') {
          perform(kind);
          return;
        }
        const now = performance.now();
        if (now - lastTap < 240) {
          if (tap) clearTimeout(tap);
          tap = null;
          lastTap = -Infinity;
          return;
        }
        lastTap = now;
        tap = setTimeout(() => {
          tap = null;
          if (!contents.window.getSelection()?.toString()) perform(kind);
        }, 220);
      },
      { signal: listeners.signal },
    );
    doc.addEventListener(
      'pointercancel',
      () => {
        start = null;
        pointers.clear();
        multitouch = false;
        if (tap) clearTimeout(tap);
      },
      { signal: listeners.signal },
    );
    doc.addEventListener(
      'click',
      (event) => {
        const target = event.target;
        const element =
          target && 'nodeType' in target && target.nodeType === 1
            ? (target as Element)
            : null;
        if (this.speedStop) {
          event.preventDefault();
          return;
        }
        const anchor = element?.closest('a');
        if (!anchor) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const href = anchor.getAttribute('href') ?? '';
        try {
          const path = this.options.index.spine[contents.sectionIndex]?.path;
          if (!path) return;
          const resolved = resolveReference(path, href);
          void this.goTo(resolved).catch((error: unknown) => {
            this.options.onError(
              error instanceof Error ? error.message : 'Ссылка недоступна',
            );
          });
        } catch {
          this.options.onError('Внешние ссылки в читалке отключены.');
        }
      },
      { capture: true, signal: listeners.signal },
    );
    doc.addEventListener(
      'keydown',
      (event) => {
        if (this.speedStop) {
          if ([' ', 'Escape', 'ArrowRight', 'ArrowLeft'].includes(event.key)) {
            event.preventDefault();
            this.speedStop();
          }
          return;
        }
        if (
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          contents.window.getSelection()?.toString()
        )
          return;
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault();
          perform(event.key === 'ArrowRight' ? 'next' : 'previous');
        } else if (event.key === 'Escape') this.options.onToggleControls();
      },
      { signal: listeners.signal },
    );
    return () => {
      listeners.abort();
      stopSelection();
      if (tap) clearTimeout(tap);
      if (this.content === contents) this.content = null;
    };
  }
  private endOperation() {
    this.operations--;
    if (this.disposed && this.operations === 0) this.queueRelease();
  }
  private queueRelease() {
    if (this.releaseQueued) return;
    this.releaseQueued = true;
    // epub.js destroy does not cancel its queued startup/reportLocation RAFs.
    // Drain those after in-flight public operations, before destroying their Book.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.releaseBook();
      });
    });
  }
  private releaseBook() {
    this.contentCleanup?.();
    this.contentCleanup = null;
    this.rendition?.off('relocated', this.relocated);
    this.rendition = null;
    if (!this.openingBook) {
      const book = this.book;
      this.book = null;
      book?.destroy();
    }
    // Book.destroy removes its own stage; never clear a host reused by a newer session.
    this.latest = null;
  }
  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.speedStop = null;
    this.speedSource = null;
    this.clearSpeedRange();
    this.ready = false;
    this.gate.destroy();
    this.options.signal.removeEventListener('abort', this.abort);
    window.removeEventListener('resize', this.viewportResize, {
      capture: true,
    });
    window.visualViewport?.removeEventListener('resize', this.viewportResize);
    this.motion.removeEventListener('change', this.motionChanged);
    this.waitCleanup?.();
    this.observer?.disconnect();
    this.observer = null;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = null;
    this.contentCleanup?.();
    this.contentCleanup = null;
    this.rendition?.off('relocated', this.relocated);
    if (this.operations === 0) this.queueRelease();
    this.buffer = null;
  }
}

export async function openEpubReader(
  options: ReaderOpenOptions,
  analyze: EpubAdapter['analyze'],
): Promise<ReaderSession> {
  return new EpubReaderSession(options, analyze).start();
}
