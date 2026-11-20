import { useEffect, useState } from 'react';
import type { LibrarySnapshot, LocalStore } from '../../domain/repositories';
import type { Id, ReadingPosition } from '../../domain/model';
import { BookCover } from '../../ui/BookCover';
import { useBlobUrl } from '../../ui/useBlobUrl';
import { Button } from '../../ui/Button';
import { onlineBookCover } from '../../services/catalog';
import { flattenNavigation } from '../../domain/reader';

const chapterLabel = (name: string | undefined): string =>
  name && !/^(?:Раздел\s+\d+|Без названия)$/iu.test(name.trim())
    ? name.trim()
    : '';

export function ContinueReading({
  snapshot,
  positions,
  store,
  hidden,
  onRead,
}: {
  snapshot: LibrarySnapshot;
  positions: ReadingPosition[];
  store: LocalStore;
  hidden: boolean;
  onRead: (bookId: Id, fileId: Id, readingId: Id) => void;
}) {
  const [chosen, setChosen] = useState('');
  const [indexedChapter, setIndexedChapter] = useState<{
    positionId: Id;
    name: string;
  } | null>(null);
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
    available.find((entry) => entry.position.id === chosen) ?? available[0];
  const local = useBlobUrl(last?.book.cover ?? null);
  const positionId = last?.position.id;
  const spineIndex = last?.position.cursor?.spineIndex;
  const fileId = last?.file.id;
  const savedChapter = chapterLabel(last?.position.chapter);
  useEffect(() => {
    if (savedChapter || spineIndex === undefined || !fileId || !positionId)
      return;
    let active = true;
    void store
      .getEpubIndex(fileId)
      .then((index) => {
        if (!active || !index) return;
        const path = index.spine[spineIndex]?.path;
        const labels = flattenNavigation(index.navigation).filter(
          (item) => item.path === path,
        );
        const name = chapterLabel(
          labels.find((item) => !item.fragment)?.label ??
            (labels.length === 1 ? labels[0]?.label : undefined),
        );
        setIndexedChapter({ positionId, name });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [fileId, positionId, savedChapter, spineIndex, store]);
  if (!last) return null;
  const { book, file, reading, position } = last;
  const cover = local ?? onlineBookCover(book);
  const chapter =
    savedChapter ||
    (indexedChapter?.positionId === position.id ? indexedChapter.name : '');
  return (
    <section
      className="continue-reading"
      hidden={hidden}
      aria-label="Продолжить чтение"
    >
      <BookCover
        compact
        title={book.title}
        {...(cover ? { url: cover } : {})}
      />
      <div className="continue-reading__body">
        <h2 title={book.title}>{book.title}</h2>
        <div className="continue-reading__position">
          <div className="continue-progress">
            <progress
              aria-label="Сохранённая позиция"
              value={position.progression}
              max={1}
            />
            <span>{Math.round(position.progression * 100)}%</span>
          </div>
          {chapter && (
            <p className="continue-section" title={chapter}>
              {chapter}
            </p>
          )}
        </div>
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
            value={position.id}
            onChange={(event) => {
              setChosen(event.target.value);
            }}
          >
            {available.map((entry) => (
              <option key={entry.position.id} value={entry.position.id}>
                {entry.book.title}
              </option>
            ))}
          </select>
        </label>
      )}
    </section>
  );
}
