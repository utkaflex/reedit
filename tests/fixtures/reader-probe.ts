import { EpubJsAdapter } from '../../src/infrastructure/epub/EpubJsAdapter';
import { newId, type EpubIndex } from '../../src/domain/model';
import {
  defaultReaderPreferences,
  type ReaderSession,
} from '../../src/domain/reader';

/** Browser-only diagnostic harness; never included in the application entry point. */
export async function probeReader(
  bytes: number[],
  mode: 'paginated' | 'scroll' = 'paginated',
) {
  const adapter = new EpubJsAdapter();
  const abort = new AbortController();
  const file = new File([new Uint8Array(bytes)], 'probe.epub', {
    type: 'application/epub+zip',
  });
  const analysis = await adapter.analyze(file, abort.signal, () => undefined);
  const base = { createdAt: Date.now(), updatedAt: Date.now() };
  const fileId = newId();
  const index: EpubIndex = {
    ...base,
    id: newId(),
    bookFileId: fileId,
    sha256: analysis.sha256,
    indexVersion: 1,
    safetyPolicyVersion: 1,
    metadata: analysis.metadata,
    packagePath: analysis.packagePath,
    epubVersion: analysis.version,
    manifest: analysis.manifest,
    spine: analysis.spine,
    navigation: analysis.navigation,
    sections: analysis.sections,
    totalWords: analysis.sections.reduce(
      (sum, item) => sum + item.wordCount,
      0,
    ),
    totalCharacters: analysis.sections.reduce(
      (sum, item) => sum + item.text.length,
      0,
    ),
  };
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:390px;height:600px;';
  document.body.append(host);
  const stages: string[] = [];
  let session: ReaderSession | undefined;
  const timer = setTimeout(() => {
    abort.abort();
  }, 25000);
  try {
    session = await adapter.openReader({
      host,
      file: {
        ...base,
        id: fileId,
        bookId: newId(),
        name: file.name,
        mediaType: 'application/epub+zip',
        data: file,
        sha256: analysis.sha256,
      },
      index,
      preferences: { ...defaultReaderPreferences, mode },
      cfi: null,
      signal: abort.signal,
      onProgress: (message) => {
        stages.push(message);
      },
      onLocation: () => undefined,
      onBusy: () => undefined,
      onToggleControls: () => undefined,
      onError: () => undefined,
    });
    const frame = host.querySelector('iframe');
    const paragraph = frame?.contentDocument?.querySelector('p');
    const letterSpacing = paragraph
      ? frame?.contentWindow?.getComputedStyle(paragraph).letterSpacing
      : '';
    return { ready: true, stages, error: '', letterSpacing };
  } catch (error) {
    return {
      ready: false,
      stages,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    abort.abort();
    session?.destroy();
  }
}
