import { useState } from 'react';
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
  const [chosen, setChosen] = useState('');
  const available = [...positions]
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
    });
  const last =
    available.find((entry) => entry.reading.id === chosen) ?? available[0];
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
      <div className="continue-reading__body">
        <p className="eyebrow">Продолжить чтение</p>
        <h2>{book.title}</h2>
        <p className="caption">{book.authors.join(', ')}</p>
        <div className="continue-progress">
          {position.cursor && (
            <span className="continue-section">
              Раздел {position.cursor.spineIndex + 1}
            </span>
          )}
          <progress
            aria-label="Сохранённая позиция"
            value={position.progression}
            max={1}
          />
          <span>{Math.round(position.progression * 100)}%</span>
        </div>
        <Button
          variant="primary"
          aria-label="Продолжить чтение"
          onClick={() => {
            onRead(book.id, file.id, reading.id);
          }}
        >
          Продолжить
        </Button>
        {available.length > 1 && (
          <label className="continue-switch">
            <span className="visually-hidden">Другие текущие книги</span>
            <select
              aria-label="Другие текущие книги"
              value={reading.id}
              onChange={(event) => {
                setChosen(event.target.value);
              }}
            >
              {available.map((entry) => (
                <option key={entry.reading.id} value={entry.reading.id}>
                  {entry.book.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </section>
  );
}
