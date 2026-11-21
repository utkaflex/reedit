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
  type ReaderSearchMatch,
  type ReaderSession,
  type ReaderTarget,
} from '../../domain/reader';
import { ReaderNavigationGate } from '../../services/reader-navigation';
import { resolveReference } from './xml';
import {
  explicitNoteLink,
  missingLegacyNote,
  noteDestination,
  noteText,
  numberLink,
  reciprocalNote,
  semanticNote,
} from './footnotes';
import { observeNativeSelection } from './native-selection';
import {
  buildDocumentTextIndex,
  indexTextSection,
  createIndexScheduler,
} from './text-index';
import { prepareTextDocument } from './text-dom';
import { PositionResolver } from './PositionResolver';
import { GuidedScroll } from './GuidedScroll';
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

import { ReaderDiagnostics } from '../../services/reader-diagnostics';

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
  private readonly diagnostics = new ReaderDiagnostics();
  private originalSpeedMode: ReaderPreferences['mode'] | null = null;
  private readonly guidedScroll = new GuidedScroll(() => {
    this.drawSpeedRange(false);
  });
  private speedScrollWpm: number | null = null;
  setSpeedScrollPlayback(playing: boolean, wpm: number): void {
    if (!playing) {
      this.speedScrollWpm = null;
      this.guidedScroll.stop();
      return;
    }
    this.speedScrollWpm = wpm;
    this.centerSpeedLine();
  }
  async setSpeedCentering(enabled: boolean): Promise<void> {
    if (enabled === (this.originalSpeedMode !== null)) return;
    const deadline = performance.now() + 5000;
    while (this.gate.busy && !this.disposed && performance.now() < deadline)
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    this.ensureAlive();
    if (enabled && this.originalSpeedMode === null) {
      const mode = this.preferences.mode;
      if (
        mode !== 'scroll' &&
        !(await this.setPreferences({ ...this.preferences, mode: 'scroll' }))
      )
        throw new Error('Не удалось включить прокрутку.');
      this.originalSpeedMode = mode;
    } else if (!enabled && this.originalSpeedMode !== null) {
      if (
        this.preferences.mode !== this.originalSpeedMode &&
        !(await this.setPreferences({
          ...this.preferences,
          mode: this.originalSpeedMode,
        }))
      )
        throw new Error('Не удалось восстановить режим страницы.');
      this.originalSpeedMode = null;
    }
  }
  private speedStop: (() => void) | null = null;
  private returnCursor: ReadingCursor | null = null;
  private sourceCache: { spineIndex: number; doc: Document } | null = null;
  private speedRange: {
    start: ReadingCursor;
    end: ReadingCursor;
    focusEnd: ReadingCursor | null;
  } | null = null;
  private speedOverlay: HTMLDivElement | null = null;
  private searchRange: { start: ReadingCursor; end: ReadingCursor } | null =
    null;
  private searchOverlay: HTMLDivElement | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private highlights: Annotation[] = [];
  private drawnHighlights: string[] = [];
  private book: Book | null = null;
  private rendition: Rendition | null = null;
  private mounted = new Map<
    Contents,
    { frame: Element; cleanup: () => void }
  >();
  private frameObserver: MutationObserver | null = null;
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
    for (const contents of this.mounted.keys()) this.styleContent(contents);
    this.centerSpeedLine();
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
    if (
      this.disposed ||
      !location.start.cfi ||
      !this.contentFor(location.start.index)
    )
      return;
    this.latest = location;
    if (this.ready && !this.muted && !this.guidedScroll.moving) {
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
      const checked = await this.diagnostics.measure('validate-file', () =>
        this.analyze(
          {
            name: representation ? 'converted.epub' : this.options.file.name,
            size: data.size,
            type: 'application/epub+zip',
            arrayBuffer: () => data.arrayBuffer(),
          },
          this.options.signal,
          (message) => this.options.onProgress?.(message),
        ),
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
      this.buffer = await this.diagnostics.measure('read-blob', () =>
        checked.original.arrayBuffer(),
      );
      this.ensureAlive();
      this.options.onProgress?.('Открываем содержимое EPUB…');
      await this.createBook();
      if (!this.textIndex) throw new Error('Текстовый индекс не готов.');
      this.diagnostics.mark('restore-anchor', 'started');
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
      this.diagnostics.mark('restore-anchor', 'success');
      this.options.onProgress?.('Восстанавливаем место и готовим страницу…');
      await this.settle(
        () => this.display(initialCfi ?? undefined),
        initialCfi ?? undefined,
        restored.cursor,
      );
      this.ready = true;
      this.diagnostics.mark('ready', 'success');
      this.observeResize();
      return this;
    } catch (error) {
      this.diagnostics.mark(
        'ready',
        this.options.signal.aborted ? 'cancelled' : 'failure',
      );
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
  private contentFor(index: number): Contents | undefined {
    for (const [contents, { frame }] of this.mounted) {
      if (contents.sectionIndex === index && this.options.host.contains(frame))
        return contents;
    }
  }
  private pruneContents(): void {
    let removed = false;
    for (const [contents, { frame, cleanup }] of this.mounted) {
      if (this.options.host.contains(frame)) continue;
      cleanup();
      this.mounted.delete(contents);
      removed = true;
    }
    if (removed && !this.speedStop)
      this.options.onSelection?.(this.getSelection());
  }
  private clearContents(): void {
    this.frameObserver?.disconnect();
    this.frameObserver = null;
    for (const { cleanup } of this.mounted.values()) cleanup();
    this.mounted.clear();
  }
  private async display(target?: string): Promise<void> {
    await this.diagnostics.measure('display', () =>
      this.requireRendition().display(target),
    );
    this.ensureAlive();
    if (!target) return;
    const section = this.book?.spine.get(target);
    const doc = section && this.contentFor(section.index)?.document;
    if (!doc) return;
    // A freshly scrolled view can clamp its first target before its height expands.
    // Wait for local resource layout, then use the public display API on the same target.
    await this.diagnostics.measure(
      'layout',
      () =>
        new Promise<void>((resolve, reject) => {
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
              new Error(
                'Не удалось дождаться раскладки EPUB. Повторите переход.',
              ),
            );
          }, 5000);
          this.options.signal.addEventListener('abort', cancelled, {
            once: true,
          });
          void Promise.all([
            this.diagnostics.measure('fonts-ready', () => doc.fonts.ready),
            this.diagnostics.measure('images-ready', () =>
              Promise.all(
                Array.from(doc.getElementsByTagName('img'), (image) =>
                  image.decode().catch(() => undefined),
                ),
              ),
            ),
          ]).then(
            () => {
              cleanup();
              resolve();
            },
            (error: unknown) => {
              cleanup();
              reject(
                error instanceof Error
                  ? error
                  : new Error('Ошибка раскладки EPUB'),
              );
            },
          );
        }),
    );
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
    const buffer = this.buffer;
    const book = new Book({
      replacements: 'blobUrl',
      requestMethod: () =>
        Promise.reject(new Error('Сетевые запросы из EPUB запрещены')),
    });
    this.book = book;
    this.openingBook = true;
    try {
      await this.diagnostics.measure('open-package', () =>
        operationDeadline(
          book.open(buffer, 'binary'),
          this.options.signal,
          15000,
          'Не удалось открыть содержимое EPUB за 15 секунд. Попробуйте другое издание или повторите открытие. Книга сохранена.',
        ),
      );
      await this.diagnostics.measure('package-ready', () =>
        operationDeadline(
          book.ready,
          this.options.signal,
          15000,
          'Не удалось загрузить структуру книги. Файл сохранён; попробуйте повторить открытие.',
        ),
      );
      await this.diagnostics.measure(
        'resources-ready',
        () => book.loaded.resources,
      );
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
    this.diagnostics.mark('prepare-document', 'started');
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
    this.diagnostics.mark('prepare-document', 'success');
    this.ensureAlive();
    const { width, height } = this.measure();
    this.size = { width, height };
    const rendition = book.renderTo(this.options.host, {
      width,
      height,
      manager: this.preferences.mode === 'scroll' ? 'continuous' : 'default',
      offset: height,
      method: 'blobUrl',
      flow:
        this.preferences.mode === 'paginated'
          ? 'paginated'
          : 'scrolled-continuous',
      spread: 'none',
      gap: this.preferences.margin * 2,
      allowScriptedContent: false,
      allowPopups: false,
      snap: false,
      resizeOnOrientationChange: false,
    });
    this.rendition = rendition;
    this.frameObserver = new MutationObserver(() => {
      this.pruneContents();
    });
    this.frameObserver.observe(this.options.host, {
      childList: true,
      subtree: true,
    });
    rendition.on('relocated', this.relocated);
    rendition.hooks.content.register((contents: Contents) => {
      const frame = contents.window.frameElement;
      if (
        this.disposed ||
        this.rendition !== rendition ||
        !frame ||
        this.mounted.has(contents)
      )
        return;
      this.diagnostics.mark('iframe-content', 'success');
      this.styleContent(contents);
      this.mounted.set(contents, {
        frame,
        cleanup: this.listenToContent(contents),
      });
      this.drawHighlights();
    });
    await this.diagnostics.measure('renderer-started', () => rendition.started);
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
    style.textContent = `html { background:${background} !important; color:${text} !important; overflow-wrap:anywhere; -webkit-text-size-adjust:100%; } body { font-family:${font} !important; font-size:${String(this.preferences.fontSize)}px !important; line-height:${String(this.preferences.lineHeight)} !important; color:${text} !important; background:${background} !important; text-align:${this.preferences.alignment} !important; padding-top:16px !important; padding-bottom:16px !important; ${this.preferences.mode === 'scroll' ? `padding-left:${String(this.preferences.margin)}px !important;padding-right:${String(this.preferences.margin)}px !important;` : ''} } p,li,blockquote,div { font-family:inherit !important; font-size:1em !important; line-height:inherit !important; color:inherit !important; text-align:inherit !important; } h1,h2,h3,h4,h5,h6 { font-family:inherit !important; line-height:1.3 !important; overflow-wrap:anywhere; break-after:avoid; } p { orphans:2; widows:2; hyphens:auto; -webkit-hyphens:auto; text-align-last:start; word-spacing:normal !important; } h1,h2,h3 { text-align:center !important; font-weight:600; } blockquote { margin-inline:1em; } img,svg,video { max-width:100% !important; height:auto; max-height:90vh; object-fit:contain; } pre { white-space:pre-wrap !important; overflow-wrap:anywhere; } table { max-width:100% !important; table-layout:fixed; } * { box-sizing:border-box; } a { color:inherit; text-decoration:underline; } ::selection { background:rgba(112,85,232,.25); } ${!this.preferences.animations || window.matchMedia('(prefers-reduced-motion: reduce)').matches ? '* { animation:none !important; transition:none !important; scroll-behavior:auto !important; }' : ''}`;
    style.textContent += `body * { font-family:inherit !important; color:inherit !important; background-color:transparent !important; } body span { font-size:inherit !important; line-height:inherit !important; } body pre,body code { font-family:ui-monospace,monospace !important; }`;
    // Publisher CSS must not disable the reader's native selection contract.
    style.textContent +=
      'html,body,body p,body span,body div,body li,body blockquote,body h1,body h2,body h3,body h4 { -webkit-user-select:text !important; user-select:text !important; -webkit-touch-callout:default !important; }';
    style.textContent +=
      'a[role="doc-noteref"], a[epub\\:type~="noteref"] { vertical-align:super; font-size:.76em !important; font-weight:700; text-decoration:underline; color:var(--reedit-note) !important; }';
    contents.document.documentElement.style.setProperty(
      '--reedit-note',
      this.preferences.theme === 'dark' ? '#f4aa91' : '#8f3c2c',
    );
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
    contents.window.frameElement?.setAttribute('title', 'Текст книги');
  }
  private chapter(location: Location): string {
    const path = this.options.index.spine[location.start.index]?.path;
    const candidates = flattenNavigation(this.options.index.navigation).filter(
      (item) => item.path === path,
    );
    let title = candidates.find((item) => !item.fragment)?.label ?? '';
    const content = this.contentFor(location.start.index);
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
    if (title.trim() && !/^Раздел\s+\d+$/iu.test(title.trim())) return title;
    return content?.document.querySelector('h1,h2')?.textContent.trim() ?? '';
  }
  private publish(
    location: Location,
    anchor?: string,
    preserved?: ReadingCursor,
  ) {
    if (this.disposed || !location.start.cfi.startsWith('epubcfi(')) return;
    const index = preserved?.spineIndex ?? location.start.index;
    const item = this.options.index.spine[index];
    if (!item) return;
    const content = this.contentFor(index);
    if (!this.textIndex || !this.resolver || !content)
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
        !this.visibleRangeRects(
          this.returnCursor,
          cursorAt(this.textIndex, section.spineIndex, token.end),
        ).length
      )
        this.returnCursor = null;
    }
    const cursor =
      preserved ??
      (this.returnCursor?.spineIndex === index ? this.returnCursor : null) ??
      this.resolver.fromCfi(anchor ?? location.start.cfi, content.document);
    cursorSection(this.textIndex, cursor);
    if (cursor.spineIndex !== index)
      throw new Error('Отображаемый раздел не совпадает с текстовой позицией.');
    const cfi = this.resolver.toCfi(cursor, content.document);
    const result: ReaderLocation = {
      cfi,
      cursor,
      path: item.path,
      spineIndex: index,
      chapter: this.chapter({
        ...location,
        start: { ...location.start, index, cfi },
      }),
      progression: new ReadingProgressService(this.textIndex).relative(cursor),
      atStart: location.atStart,
      atEnd: location.atEnd,
    };
    const { page, total } = location.start.displayed;
    if (this.preferences.mode === 'paginated' && page >= 1 && page <= total)
      result.page = { number: page, total };
    // Engine viewport boundaries, deliberately independent of the sticky restore cursor.
    try {
      if (location.start.index === index) {
        const start = this.resolver.fromCfi(
          location.start.cfi,
          content.document,
        );
        const end =
          location.end.index === index
            ? this.resolver.fromCfi(location.end.cfi, content.document)
            : cursorAt(
                this.textIndex,
                index,
                cursorSection(this.textIndex, start).text.length,
              );
        if (end.offset > start.offset) result.visible = { start, end };
      }
    } catch {
      /* An unresolved boundary cannot be credited as read text. */
    }
    this.lastConfirmed = result;
    this.drawSpeedRange(false);
    this.drawSearchMatch();
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
      await this.diagnostics.measure(
        'relocation',
        () =>
          new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              clearTimeout(timer);
              rendition.off('relocated', confirmed);
              this.options.signal.removeEventListener('abort', cancelled);
              this.waitCleanup = null;
            };
            const confirmed = (location: Location) => {
              if (!location.start.cfi || !this.contentFor(location.start.index))
                return;
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
          }),
      );
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
  goToPage(number: number) {
    const page = this.lastConfirmed?.page;
    if (!page || !Number.isInteger(number) || number < 1 || number > page.total)
      return Promise.reject(new Error('Такой страницы в текущем разделе нет.'));
    if (number === page.number) return Promise.resolve(true);
    return this.command(() => {
      const viewport =
        this.options.host.querySelector<HTMLElement>('.epub-container');
      if (!viewport)
        return Promise.reject(new Error('Страница ещё не готова.'));
      // With spreads disabled, epub.js advances by one viewport width.
      const direction = getComputedStyle(viewport).direction === 'rtl' ? -1 : 1;
      this.returnCursor = null;
      viewport.scrollLeft = direction * (number - 1) * viewport.clientWidth;
      return Promise.resolve();
    });
  }
  setSpeedInteraction(onStop: (() => void) | null): void {
    this.speedStop = onStop;
    if (onStop) this.returnCursor = null;
  }
  private async sourceDocument(spineIndex: number): Promise<Document> {
    this.ensureAlive();
    const content = this.contentFor(spineIndex);
    if (content) return content.document;
    if (this.sourceCache?.spineIndex === spineIndex)
      return this.sourceCache.doc;
    if (!this.book) throw new Error('Книга закрыта.');
    const doc = await this.book.load(this.book.spine.get(spineIndex).url);
    this.ensureAlive();
    if (!isDocument(doc)) throw new Error('DOM раздела недоступен.');
    prepareTextDocument(doc);
    this.sourceCache = { spineIndex, doc };
    return doc;
  }
  getTextIndex(): DocumentTextIndex | null {
    return this.textIndex;
  }
  async searchText(
    query: string,
    signal: AbortSignal,
  ): Promise<ReaderSearchMatch[]> {
    const index = this.textIndex;
    if (!index) throw new Error('Текст книги ещё готовится.');
    const phrase = query
      .normalize('NFC')
      .replace(/[\u00ad\u200b\ufeff]/gu, '')
      .trim()
      .replace(/\s+/gu, ' ');
    if (!phrase) return [];
    const pattern = new RegExp(
      phrase.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&'),
      'giu',
    );
    const navigation = flattenNavigation(this.options.index.navigation);
    const matches: ReaderSearchMatch[] = [];
    const schedule = createIndexScheduler(signal);
    this.operations++;
    try {
      for (const section of index.sections) {
        const pauseBeforeSection = schedule();
        if (pauseBeforeSection) await pauseBeforeSection;
        pattern.lastIndex = 0;
        const first = pattern.exec(section.text);
        if (!first) continue;
        const doc = await this.sourceDocument(section.spineIndex);
        signal.throwIfAborted();
        const items = navigation.filter(
          (item) =>
            item.path === section.path &&
            item.label.trim() &&
            !/^Раздел\s+\d+$/iu.test(item.label.trim()),
        );
        const markers = items
          .flatMap((item) => {
            const element = item.fragment
              ? doc.getElementById(item.fragment)
              : null;
            if (!item.fragment) return [{ offset: 0, label: item.label }];
            if (!element || !this.resolver || !doc.body.contains(element))
              return [];
            const range = doc.createRange();
            range.selectNodeContents(element);
            return [
              {
                offset: this.resolver.fromRange(section.spineIndex, range)
                  .offset,
                label: item.label,
              },
            ];
          })
          .sort((a, b) => a.offset - b.offset);
        let chapter =
          doc.querySelector('h1,h2,h3')?.textContent.trim() ||
          'Раздел ' + String(section.spineIndex + 1);
        let marker = 0;
        let nextChapter = markers[marker];
        for (
          let hit: RegExpExecArray | null = first;
          hit;
          hit = pattern.exec(section.text)
        ) {
          const start = hit.index;
          while (nextChapter && nextChapter.offset <= start) {
            chapter = nextChapter.label;
            nextChapter = markers[++marker];
          }
          matches.push({
            spineIndex: section.spineIndex,
            start,
            end: start + hit[0].length,
            chapter,
            text: section.text,
          });
          const pause = schedule();
          if (pause) await pause;
        }
      }
      return matches;
    } finally {
      this.endOperation();
    }
  }
  async goToSearchMatch(match: ReaderSearchMatch): Promise<boolean> {
    if (!this.textIndex) throw new Error('Текст книги ещё готовится.');
    const start = cursorAt(this.textIndex, match.spineIndex, match.start);
    const end = cursorAt(this.textIndex, match.spineIndex, match.end);
    if (!(await this.goToCursor(start))) return false;
    this.searchRange = { start, end };
    this.drawSearchMatch();
    return true;
  }
  clearSearchMatch(): void {
    this.searchRange = null;
    this.searchOverlay?.remove();
    this.searchOverlay = null;
  }
  private drawSearchMatch = () => {
    if (!this.searchRange || this.disposed) return;
    const overlay = this.searchOverlay ?? document.createElement('div');
    overlay.className = 'reader-search-highlight';
    overlay.setAttribute('aria-hidden', 'true');
    const rects = this.visibleRangeRects(
      this.searchRange.start,
      this.searchRange.end,
    );
    overlay.replaceChildren(
      ...rects.map(({ left, top, width, height }) => {
        const mark = document.createElement('span');
        Object.assign(mark.style, {
          left: String(left) + 'px',
          top: String(top) + 'px',
          width: String(width) + 'px',
          height: String(height) + 'px',
        });
        return mark;
      }),
    );
    if (!overlay.isConnected) this.options.host.append(overlay);
    this.searchOverlay = overlay;
  };
  async getSpeedDocument(): Promise<SpeedDocument> {
    if (!this.textIndex || !this.resolver)
      throw new Error('Текстовый индекс не готов.');
    this.operations++;
    try {
      const paragraphEnds: Record<number, number[]> = {};
      const yieldTask = createIndexScheduler(this.options.signal);
      for (const section of this.textIndex.sections) {
        const doc = await this.sourceDocument(section.spineIndex);
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
      const doc = await this.sourceDocument(cursor.spineIndex);
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
  private visibleRangeRects(
    start: ReadingCursor,
    end: ReadingCursor,
    visibleOnly = true,
  ): { left: number; top: number; width: number; height: number }[] {
    const content = this.contentFor(start.spineIndex);
    if (!content || !this.resolver) return [];
    const range = this.resolver.rangeBetween(start, end, content.document);
    const host = this.options.host.getBoundingClientRect();
    const frame = content.window.frameElement?.getBoundingClientRect();
    if (!frame) return [];
    return Array.from(range.getClientRects())
      .filter(
        (rect) =>
          rect.width > 0 &&
          rect.height > 0 &&
          (!visibleOnly ||
            (rect.bottom + frame.top > host.top &&
              rect.top + frame.top < host.bottom &&
              rect.right + frame.left > host.left &&
              rect.left + frame.left < host.right)),
      )
      .map((rect) => ({
        left: rect.left + frame.left - host.left,
        top: rect.top + frame.top - host.top,
        width: rect.width,
        height: rect.height,
      }));
  }
  private drawSpeedRange(animate = true): void {
    if (!this.speedRange || this.disposed) return;
    const overlay = this.speedOverlay ?? document.createElement('div');
    overlay.className = 'speed-highlight-layer';
    overlay.setAttribute('aria-hidden', 'true');
    const rects = this.visibleRangeRects(
      this.speedRange.start,
      this.speedRange.end,
    );
    // Inline markup can yield several DOM rectangles for one line.
    const lines: typeof rects = [];
    for (const rect of rects) {
      const line = lines.find(
        (candidate) => Math.abs(candidate.top - rect.top) < rect.height / 3,
      );
      if (!line) lines.push({ ...rect });
      else {
        const right = Math.max(line.left + line.width, rect.left + rect.width);
        line.left = Math.min(line.left, rect.left);
        line.width = right - line.left;
      }
    }
    const old = Array.from(overlay.children);
    lines.forEach((rect, index) => {
      const previous = old[index];
      const mark =
        previous instanceof HTMLSpanElement
          ? previous
          : document.createElement('span');
      const top = parseFloat(mark.style.top);
      const sameLine =
        Number.isFinite(top) && Math.abs(top - rect.top) < rect.height / 2;
      mark.className = 'speed-word-highlight';
      if (animate || !previous)
        mark.style.transition =
          animate &&
          sameLine &&
          this.preferences.animations &&
          !this.motion.matches
            ? 'left 65ms linear, width 65ms linear'
            : 'none';
      Object.assign(mark.style, {
        left: String(rect.left) + 'px',
        top: String(rect.top) + 'px',
        width: String(rect.width) + 'px',
        height: String(rect.height) + 'px',
        border: '0',
        borderRadius: '6px',
        background: 'rgba(180,140,85,.24)',
      });
      if (
        animate &&
        !sameLine &&
        this.preferences.animations &&
        !this.motion.matches
      )
        mark.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 55 });
      if (!mark.isConnected) overlay.append(mark);
    });
    old.slice(lines.length).forEach((mark) => {
      mark.remove();
    });
    if (!overlay.isConnected) this.options.host.append(overlay);
    this.speedOverlay = overlay;
  }
  async showSpeedRange(
    start: ReadingCursor,
    end: ReadingCursor,
    center = false,
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
    if (!this.visibleRangeRects(start, firstEnd, !center).length) {
      this.guidedScroll.stop();
      if (!(await this.goToCursor(start)))
        throw new Error('Дождитесь завершения изменения страницы и повторите.');
    }
    const firstFocusedRange = center && !this.speedRange?.focusEnd;
    this.speedRange = {
      start: { ...start },
      end: { ...end },
      focusEnd: center ? firstEnd : null,
    };
    this.drawSpeedRange();
    this.centerSpeedLine(firstFocusedRange);
  }
  private centerSpeedLine(initial = false): void {
    const range = this.speedRange;
    if (!range?.focusEnd || (!initial && this.speedScrollWpm === null)) return;
    const container =
      this.options.host.querySelector<HTMLElement>('.epub-container');
    const line = this.visibleRangeRects(range.start, range.focusEnd, false)[0];
    if (!container || !line) return;
    const to = Math.max(
      0,
      Math.min(
        container.scrollHeight - container.clientHeight,
        container.scrollTop +
          line.top +
          line.height / 2 -
          this.options.host.clientHeight / 2,
      ),
    );
    if (initial) {
      container.scrollTop = to;
      this.drawSpeedRange(false);
      return;
    }
    if (this.speedScrollWpm === null) return;
    this.guidedScroll.moveTo(
      container,
      to,
      this.speedScrollWpm,
      !this.preferences.animations || this.motion.matches,
    );
  }
  clearSpeedRange(): void {
    this.guidedScroll.stop();
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
    const content = this.contentFor(start.spineIndex);
    if (!this.textIndex || !this.resolver || !content) return null;
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
      cfi: this.resolver.rangeCfi(start, end, content.document),
    };
  }
  private selectedRange(): { contents: Contents; range: Range } | null {
    for (const [contents, { frame }] of this.mounted) {
      if (!this.options.host.contains(frame)) continue;
      const selection = contents.window.getSelection();
      if (selection?.rangeCount && !selection.isCollapsed)
        return { contents, range: selection.getRangeAt(0) };
    }
    return null;
  }
  getSelection(): ReaderSelection | null {
    const selected = this.selectedRange();
    if (!selected || !this.resolver) return null;
    try {
      const { contents, range } = selected;
      const finish = range.cloneRange();
      finish.collapse(false);
      const start = this.resolver.fromRange(contents.sectionIndex, range);
      const end = this.resolver.fromRange(contents.sectionIndex, finish);
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
    if (!rendition || !this.resolver || !this.textIndex) return;
    for (const cfi of this.drawnHighlights)
      rendition.annotations.remove(cfi, 'highlight');
    this.drawnHighlights = [];
    for (const item of this.highlights) {
      const a = item.anchor;
      if (!a || a.contentId !== contentIdentity(this.options.file)) continue;
      const content = this.contentFor(a.start.spineIndex);
      if (!content) continue;
      try {
        if (anchorText(this.textIndex, a) !== item.quote) continue;
        const cfi = this.resolver.rangeCfi(a.start, a.end, content.document);
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
    const selected = this.selectedRange();
    if (!selected || !this.resolver || !this.textIndex) return null;
    const { contents, range } = selected;
    const cursor = this.resolver.fromRange(contents.sectionIndex, range);
    const canonical = this.resolver.toRange(cursor, contents.document);
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
      this.contentFor(cursor.spineIndex)?.document ??
      (await this.book.load(this.book.spine.get(cursor.spineIndex).url));
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
    const anchor = this.lastConfirmed;
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
          for (const contents of this.mounted.keys())
            this.styleContent(contents);
          const { width, height } = this.measure();
          this.requireRendition().resize(width, height);
        }
        await this.display(
          anchor?.cursor ? await this.cfiForCursor(anchor.cursor) : anchor?.cfi,
        );
      },
      false,
      undefined,
      anchor?.cursor,
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
      const cursor = this.speedRange?.focusEnd
        ? this.speedRange.start
        : this.lastConfirmed?.cursor;
      void this.command(
        async () => {
          for (const contents of this.mounted.keys())
            this.styleContent(contents);
          this.requireRendition().resize(size.width, size.height);
          await this.display(cursor ? await this.cfiForCursor(cursor) : cfi);
        },
        false,
        undefined,
        cursor,
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
    this.options.host.addEventListener('scroll', this.drawSearchMatch, {
      capture: true,
      passive: true,
    });
    this.observer = new ResizeObserver(() => {
      this.viewportResize();
    });
    this.observer.observe(this.options.host);
    window.addEventListener('resize', this.viewportResize, { capture: true });
    window.visualViewport?.addEventListener('resize', this.viewportResize);
    this.motion.addEventListener('change', this.motionChanged);
  }
  private noteLink(
    anchor: Element,
    target: ReaderTarget,
    source: string,
  ): boolean {
    if (explicitNoteLink(anchor)) return true;
    if (!target.fragment || !numberLink(anchor)) return false;
    if (
      anchor.classList.contains('fb2-a') &&
      this.options.fb2NoteReferences?.has(
        target.fragment + ':' + anchor.textContent.trim(),
      )
    )
      return true;
    if (/(?:^|\/)(?:footnotes|endnotes|notes)\.x?html?$/iu.test(target.path))
      return true;
    if (target.path !== source) return false;
    const destination = noteDestination(anchor.ownerDocument, target.fragment);
    return destination
      ? Boolean(
          semanticNote(destination) ??
          reciprocalNote(anchor, destination, source),
        )
      : missingLegacyNote(anchor, target.fragment);
  }
  private async followLink(
    anchor: Element,
    target: ReaderTarget,
    contents: Contents,
  ): Promise<void> {
    const source = this.options.index.spine[contents.sectionIndex]?.path;
    if (explicitNoteLink(anchor) && !target.fragment) {
      this.speedStop?.();
      this.guidedScroll.stop();
      this.options.onMissingFootnote?.();
      return;
    }
    if (
      source &&
      target.fragment &&
      (explicitNoteLink(anchor) || numberLink(anchor))
    ) {
      const known = this.noteLink(anchor, target, source);
      const doc: unknown =
        source === target.path
          ? contents.document
          : await this.book?.load('/' + target.path).catch(() => null);
      if (this.disposed || this.contentFor(contents.sectionIndex) !== contents)
        return;
      const destination = isDocument(doc)
        ? noteDestination(doc, target.fragment)
        : null;
      const note =
        destination &&
        (semanticNote(destination) ??
          (source === target.path
            ? reciprocalNote(anchor, destination, source)
            : null) ??
          (known ? destination : null));
      if (known || note) {
        this.speedStop?.();
        this.guidedScroll.stop();
        const text = destination && note ? noteText(note, destination) : '';
        if (text) this.options.onFootnote?.(text);
        else this.options.onMissingFootnote?.();
        return;
      }
    }
    if (this.speedStop) return;
    if (this.options.onInternalLink && this.lastConfirmed)
      this.options.onInternalLink(target, this.lastConfirmed);
    else await this.goTo(target);
  }
  private listenToContent(contents: Contents): () => void {
    const doc = contents.document;
    const source = this.options.index.spine[contents.sectionIndex]?.path;
    if (source) {
      for (const anchor of doc.querySelectorAll('a[href]')) {
        try {
          const target = resolveReference(
            source,
            anchor.getAttribute('href') ?? '',
          );
          if (this.noteLink(anchor, target, source))
            anchor.setAttribute('role', 'doc-noteref');
        } catch {
          /* Non-local links retain the normal link policy. */
        }
      }
    }
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
      if (
        !this.disposed &&
        this.contentFor(contents.sectionIndex) === contents &&
        !this.speedStop
      )
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
      else if (kind !== 'none' && !this.speedStop)
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
    const linkAt = (target: EventTarget | null) =>
      target && 'nodeType' in target && target.nodeType === 1
        ? (target as Element).closest('a[href]')
        : null;
    const activateLink = (anchor: Element) => {
      if (!source) return;
      try {
        const resolved = resolveReference(
          source,
          anchor.getAttribute('href') ?? '',
        );
        void this.followLink(anchor, resolved, contents).catch(
          (error: unknown) => {
            this.options.onError(
              error instanceof Error ? error.message : 'Ссылка недоступна',
            );
          },
        );
      } catch {
        this.options.onError('Внешние ссылки в читалке отключены.');
      }
    };
    let noteTap: {
      anchor: Element;
      x: number;
      y: number;
      time: number;
    } | null = null;
    let touchActivation: { anchor: Element; time: number } | null = null;
    doc.addEventListener(
      'touchstart',
      (event) => {
        const anchor = linkAt(event.target);
        const touch = event.touches.length === 1 ? event.touches[0] : undefined;
        noteTap =
          anchor && touch && explicitNoteLink(anchor)
            ? {
                anchor,
                x: touch.screenX,
                y: touch.screenY,
                time: performance.now(),
              }
            : null;
      },
      { passive: true, signal: listeners.signal },
    );
    doc.addEventListener(
      'touchend',
      (event) => {
        const first = noteTap;
        noteTap = null;
        const last = event.changedTouches[0];
        if (
          !first ||
          !last ||
          event.touches.length ||
          performance.now() - first.time > 420 ||
          Math.hypot(last.screenX - first.x, last.screenY - first.y) > 12 ||
          contents.window.getSelection()?.toString()
        )
          return;
        event.preventDefault();
        touchActivation = { anchor: first.anchor, time: performance.now() };
        activateLink(first.anchor);
      },
      { passive: false, signal: listeners.signal },
    );
    doc.addEventListener(
      'touchcancel',
      () => {
        noteTap = null;
      },
      { signal: listeners.signal },
    );
    doc.addEventListener(
      'click',
      (event) => {
        const anchor = linkAt(event.target);
        if (!anchor) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (
          touchActivation?.anchor === anchor &&
          performance.now() - touchActivation.time < 500 &&
          event.detail !== 0
        )
          return;
        activateLink(anchor);
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
    this.clearContents();
    this.drawnHighlights = [];
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
    this.sourceCache = null;
    this.clearSpeedRange();
    this.clearSearchMatch();
    this.options.host.removeEventListener('scroll', this.drawSearchMatch, true);
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
    this.clearContents();
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
