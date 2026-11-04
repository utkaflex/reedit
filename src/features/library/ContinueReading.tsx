import type { LibrarySnapshot } from '../../domain/repositories';
import type { Id, ReadingPosition } from '../../domain/model';
import { BookCover } from '../../ui/BookCover';
import { useBlobUrl } from '../../ui/useBlobUrl';
import { Button } from '../../ui/Button';
import { onlineBookCover } from '../../services/catalog';

export function ContinueReading({
  snapshot,
  positions,
  onRead,
}: {
  snapshot: LibrarySnapshot;
  positions: ReadingPosition[];
  onRead: (bookId: Id, fileId: Id, readingId: Id) => void;
}) {
  const last = [...positions]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .flatMap((position) => {
      const reading = snapshot.readings.find(
        (r) =>
          r.id === position.readingId &&
          r.status !== 'finished' &&
          r.status !== 'abandoned',
      );
      const file = snapshot.files.find(
        (f) =>
          f.id === position.bookFileId &&
          f.bookId === reading?.bookId &&
          Boolean(f.sha256) &&
          (!position.cursor || f.sha256 === position.cursor.sha256),
      );
      const book = snapshot.books.find((b) => b.id === reading?.bookId);
      return book && file && reading ? [{ position, book, file, reading }] : [];
    })[0];
  const local = useBlobUrl(last?.book.cover ?? null);
  if (!last) return null;
  const { book, file, reading, position } = last;
  const cover = local ?? onlineBookCover(book);
  return (
    <section className="continue-reading" aria-label="Продолжить чтение">
      <BookCover
        title={book.title}
        authors={book.authors}
        {...(cover ? { url: cover } : {})}
      />
      <div>
        <p className="eyebrow">С вами сейчас</p>
        <h2>{book.title}</h2>
        <p className="caption">{book.authors.join(', ')}</p>
        <div className="continue-progress">
          <progress
            aria-label="Сохранённая позиция"
            value={position.progression}
            max={1}
          />
          <span>{Math.round(position.progression * 100)}%</span>
        </div>
        <Button
          variant="quiet"
          onClick={() => {
            onRead(book.id, file.id, reading.id);
          }}
        >
          Продолжить чтение →
        </Button>
      </div>
    </section>
  );
}
