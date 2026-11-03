import type { EpubAdapter, EpubSource } from '../domain/epub';
import { checkImportCancelled, EpubImportError } from '../domain/epub';
import type { ReaderOpenOptions } from '../domain/reader';
import { EpubJsAdapter } from './epub/EpubJsAdapter';
import { Fb2Adapter, sha256 } from './fb2/Fb2Adapter';
const supportedConverter = (value: unknown) => value === 1;

/** Format dispatch. The existing EPUB parser and renderer remain the shared backend. */
export class DocumentAdapter implements EpubAdapter {
  private epub = new EpubJsAdapter();
  analyze(
    file: EpubSource,
    signal: AbortSignal,
    progress: (message: string) => void,
  ) {
    return /\.fb2$/i.test(file.name)
      ? new Fb2Adapter(this.epub).analyze(file, signal, progress)
      : this.epub.analyze(file, signal, progress);
  }
  async openReader(options: ReaderOpenOptions) {
    if (options.file.mediaType === 'application/epub+zip')
      return this.epub.openReader(options);
    checkImportCancelled(options.signal);
    const representation = options.file.representation;
    if (
      !representation ||
      !supportedConverter(representation.converterVersion) ||
      !(representation.data instanceof Blob) ||
      representation.sourceSha256 !== options.file.sha256 ||
      (await sha256(await options.file.data.arrayBuffer())) !==
        options.file.sha256
    )
      throw new EpubImportError(
        'corrupt',
        'FB2 или его локальное представление не соответствует сохранённому оригиналу.',
      );
    // The shared renderer verifies the derived EPUB hash separately from source identity.
    return this.epub.openReader(options);
  }
}
