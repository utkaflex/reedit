export const sections = [
  'library',
  'quotes',
  'statistics',
  'settings',
] as const;
export type Section = (typeof sections)[number];
export type Route = Section | 'reading' | 'not-found';
import { id } from '../../domain/model';
import type { ReaderAddress } from '../../services/reader';
export function parseReaderAddress(hash: string): ReaderAddress | null {
  const parts =
    /^#\/reading\/([^/]+)\/([^/]+)\/([^/]+?)(?:\/(annotations|bookmarks)\/([^/]+))?$/.exec(
      hash,
    );
  if (!parts?.[1] || !parts[2] || !parts[3]) return null;
  try {
    return {
      bookId: id(parts[1]),
      fileId: id(parts[2]),
      readingId: id(parts[3]),
      ...(parts[4] && parts[5]
        ? {
            savedKind:
              parts[4] === 'annotations'
                ? ('annotations' as const)
                : ('bookmarks' as const),
            savedId: id(parts[5]),
          }
        : {}),
    };
  } catch {
    return null;
  }
}
export const readerUrl = (address: ReaderAddress): string =>
  `#/reading/${address.bookId}/${address.fileId}/${address.readingId}${address.savedId && address.savedKind ? `/${address.savedKind}/${address.savedId}` : ''}`;
export function parseRoute(hash: string): Route {
  if (hash === '' || hash === '#' || hash === '#/') return 'library';
  if (/^#\/quotes(?:\?book=[a-f0-9-]+)?$/.test(hash)) return 'quotes';
  const path = hash.replace(/^#\//, '');
  if (path === 'reading' || parseReaderAddress(hash)) return 'reading';
  return sections.find((section) => section === path) ?? 'not-found';
}
