import {
  newId,
  type Annotation,
  type Book,
  type HighlightColor,
  type Id,
} from '../domain/model';
import type { ReaderSelection } from '../domain/reader';
import type { LocalStore } from '../domain/repositories';

export function saveSelection(
  store: LocalStore,
  address: { bookId: Id; fileId: Id; readingId: Id },
  selection: ReaderSelection,
  color: HighlightColor,
  note: string,
) {
  const now = Date.now();
  return store.saveAnnotation({
    id: newId(),
    createdAt: now,
    updatedAt: now,
    bookId: address.bookId,
    bookFileId: address.fileId,
    readingId: address.readingId,
    ...selection,
    color,
    note: note.trim(),
  });
}
export function exportAnnotations(
  annotations: Annotation[],
  books: Book[],
  format: 'markdown' | 'text',
): string {
  const escape = (text: string) =>
    text.replace(/([\\`*_{}[\]()#+.!<>|~-])/g, '\\$1');
  return (
    annotations
      .map((item) => {
        const title =
          books.find((book) => book.id === item.bookId)?.title ?? 'Книга';
        const date = new Date(item.createdAt).toISOString();
        if (format === 'text')
          return `${title}\n${date}\n\n${item.quote}\n\n${item.note}`.trim();
        return `## ${escape(title)}\n\n${date}\n\n${item.quote
          .split('\n')
          .map((line) => `> ${escape(line)}`)
          .join('\n')}\n\n${escape(item.note)}`.trim();
      })
      .join('\n\n---\n\n') + '\n'
  );
}
export function downloadAnnotations(text: string, format: 'markdown' | 'text') {
  const url = URL.createObjectURL(
    new Blob([text], {
      type:
        format === 'markdown'
          ? 'text/markdown;charset=utf-8'
          : 'text/plain;charset=utf-8',
    }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `reedit-quotes.${format === 'markdown' ? 'md' : 'txt'}`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}
