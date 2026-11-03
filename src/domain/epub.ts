export interface EpubMetadata {
  title: string;
  authors: string[];
  language: string;
  description: string;
  identifier: string;
}
export interface EpubManifestItem {
  id: string;
  path: string;
  mediaType: string;
  properties: string[];
}
export interface EpubSpineItem {
  idref: string;
  path: string;
  linear: boolean;
}
export interface EpubNavItem {
  label: string;
  path: string;
  fragment: string;
  children: EpubNavItem[];
}
export interface EpubTextResource {
  path: string;
  spineIndex: number;
  text: string;
  wordCount: number;
}
export interface EpubAnalysis {
  sourceFormat?: 'fb2';
  representation?: import('./model').EpubRepresentation;
  sha256: string;
  original: Blob;
  metadata: EpubMetadata;
  cover: Blob | null;
  packagePath: string;
  version: string;
  manifest: EpubManifestItem[];
  spine: EpubSpineItem[];
  navigation: EpubNavItem[];
  sections: EpubTextResource[];
  warnings: string[];
}
export interface EpubSource {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export interface EpubAdapter {
  openReader(
    options: import('./reader').ReaderOpenOptions,
  ): Promise<import('./reader').ReaderSession>;
  analyze(
    file: EpubSource,
    signal: AbortSignal,
    onProgress: (message: string) => void,
  ): Promise<EpubAnalysis>;
}
export type EpubErrorCode =
  | 'format'
  | 'limit'
  | 'corrupt'
  | 'drm'
  | 'structure'
  | 'unsafe'
  | 'resource'
  | 'cancelled'
  | 'read';
export class EpubImportError extends Error {
  constructor(
    public readonly code: EpubErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
export function checkImportCancelled(signal: AbortSignal): void {
  if (signal.aborted)
    throw new EpubImportError(
      'cancelled',
      'Импорт отменён. Ничего не сохранено.',
    );
}
export const normalizeEpubText = (text: string): string =>
  text.normalize('NFC').replace(/\s+/gu, ' ').trim();
export const epubWordCount = (text: string): number =>
  text.match(/[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
