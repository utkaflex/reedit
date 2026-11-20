import {
  id,
  type Book,
  type Reading,
  type BookFileSummary,
  type ReadingPosition,
  type Id,
} from '../../domain/model';
import { useState } from 'react';
import {
  dateInput,
  readableEdition,
  readingStatus,
  statusLabels,
} from '../../domain/library';
import { useBlobUrl } from '../../ui/useBlobUrl';
import { BookCard } from '../../ui/BookCard';
import { BookCover } from '../../ui/BookCover';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import { Button } from '../../ui/Button';
import { formatCount } from '../../ui/format';
import { SelectField } from '../../ui/FormControls';
import { onlineBookCover } from '../../services/catalog';

export function LibraryCard({
  book,
  reading,
  onOpen,
  onRead,
  hasPosition,
  list,
}: {
  book: Book;
  reading: Reading | undefined;
  onOpen: () => void;
  onRead?: (() => void) | undefined;
  hasPosition: boolean;
  list: boolean;
}) {
  const url = useBlobUrl(book.cover);
  const cardCover = book.cover ? url : onlineBookCover(book);
  const readLabel = hasPosition ? 'Продолжить' : 'Читать';
  return (
    <li
      data-book-id={book.id}
      className={list ? 'library-list-item' : 'library-grid-item'}
    >
      <BookCard
        title={book.title}
        authors={book.authors}
        {...(cardCover ? { coverUrl: cardCover } : {})}
        onOpen={onOpen}
      />
      <p className="book-status">
        {statusLabels[readingStatus(reading, hasPosition)]}
        {reading?.rating ? ` · ${reading.rating.toLocaleString('ru')} / 5` : ''}
      </p>
      <details className="book-card-menu">
        <summary aria-label={`Действия с книгой «${book.title}»`}>
          <Icon name="more" />
        </summary>
        <div>
          <Button variant="quiet" onClick={onOpen}>
            О книге
          </Button>
          {onRead && (
            <Button variant="quiet" onClick={onRead}>
              Открыть для чтения
            </Button>
          )}
        </div>
      </details>
      {onRead && (
        <Button
          className="book-quick-read"
          variant="quiet"
          onClick={onRead}
          aria-label={`${readLabel} «${book.title}»`}
        >
          {readLabel}
        </Button>
      )}
    </li>
  );
}
export function BookView({
  book,
  readings,
  files,
  positions,
  onClose,
  onEdit,
  onReading,
  onReread,
  onImport,
  onRead,
  onRemoveBook,
  onRemoveFile,
  busy,
  error,
}: {
  book: Book;
  readings: Reading[];
  files: BookFileSummary[];
  positions: ReadingPosition[];
  onClose: () => void;
  onEdit: () => void;
  onReading: (reading: Reading) => void;
  onReread: () => void;
  onImport: () => void;
  onRead: (fileId: Id, readingId: Id | undefined) => void;
  onRemoveBook: () => void;
  onRemoveFile: (id: Id) => void;
  busy: boolean;
  error: string | null;
}) {
  const url = useBlobUrl(book.cover);
  const preview = book.cover ? url : onlineBookCover(book);
  const [failedPreview, setFailedPreview] = useState<string | null>(null);
  const history = readings
    .filter((reading) => reading.bookId === book.id)
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  const attached = files.filter((file) => file.bookId === book.id);
  const [selectedReading, setSelectedReading] = useState<Id | null>(null);
  const currentReading =
    history.find((reading) => reading.id === selectedReading) ?? history[0];
  const { file: readable, position } = readableEdition(
    attached,
    positions,
    book.id,
    currentReading?.id,
  );
  const statusFor = (reading: Reading) =>
    readingStatus(
      reading,
      positions.some((saved) => saved.readingId === reading.id),
    );
  const readingHistory = history.filter(
    (reading) => statusFor(reading) !== 'planned',
  );
  const plans = history.filter((reading) => statusFor(reading) === 'planned');
  const readingLabel = (reading: Reading) => {
    const index = readingHistory.indexOf(reading);
    return index === -1
      ? 'План чтения'
      : `Прочтение ${String(readingHistory.length - index)}`;
  };
  return (
    <Dialog
      open
      className="book-dialog"
      title={book.title}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="form-stack book-detail">
        <div className="book-detail-hero">
          {(!preview || preview === failedPreview) && (
            <BookCover title={book.title} />
          )}
          {preview && preview !== failedPreview && (
            <img
              className="cover-preview"
              src={preview}
              onError={() => {
                setFailedPreview(preview);
              }}
              alt={`Обложка «${book.title}»`}
            />
          )}
          <div>
            <p className="book-detail-authors">
              {book.authors.join(', ') || 'Автор не указан'}
            </p>
            <p className="status-chip">
              {statusLabels[readingStatus(currentReading, Boolean(position))]}
            </p>
          </div>
        </div>
        {!book.cover && preview && preview !== failedPreview && (
          <p className="caption">
            Обложка:{' '}
            <a
              href={`https://books.google.com/books?id=${encodeURIComponent(book.catalogIds.find((item) => item.source === 'google-books')?.value ?? '')}`}
              target="_blank"
              rel="noreferrer"
            >
              Google Books
            </a>{' '}
            · доступна онлайн
          </p>
        )}
        <div className="book-primary-action">
          <Button
            aria-label={
              readable && !position ? `Читать файл ${readable.name}` : undefined
            }
            disabled={busy}
            onClick={() => {
              if (readable) onRead(readable.id, currentReading?.id);
              else onImport();
            }}
          >
            {readable
              ? position
                ? 'Продолжить'
                : 'Читать'
              : 'Прикрепить файл'}
          </Button>
          {readable && attached.length > 1 && (
            <p className="caption">{readable.name}</p>
          )}
        </div>
        <a
          className="button button--quiet book-detail-link"
          href={`#/quotes?book=${book.id}`}
        >
          Цитаты и заметки
        </a>
        <section className="form-stack" aria-label="История чтения">
          <div className="section-heading">
            <h3>История чтения</h3>
            <span className="caption">
              {formatCount(readingHistory.length, [
                'прочтение',
                'прочтения',
                'прочтений',
              ])}
            </span>
          </div>
          {readingHistory.length === 0 && (
            <p className="caption">Прочтений пока нет.</p>
          )}
          {readingHistory.map((reading, index) => (
            <article className="reading-entry form-stack" key={reading.id}>
              <h4>
                {readingLabel(reading)} · {statusLabels[statusFor(reading)]}
              </h4>
              <p className="caption">
                {reading.startedAt === null
                  ? 'Начало не указано'
                  : `Начало: ${dateInput(reading.startedAt)}`}
                {reading.finishedAt !== null
                  ? ` · Завершение: ${dateInput(reading.finishedAt)}`
                  : ''}
              </p>
              <p>
                Оценка:{' '}
                {reading.rating === null
                  ? 'без оценки'
                  : `${reading.rating.toLocaleString('ru')} / 5`}
              </p>
              {reading.review && (
                <p className="preserve-text">{reading.review}</p>
              )}
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  onReading(reading);
                }}
              >
                Изменить прочтение {readingHistory.length - index}
              </Button>
            </article>
          ))}
          {plans.map((reading, index) => (
            <div key={reading.id} className="reading-entry">
              {reading.rating !== null && (
                <p>Оценка: {reading.rating.toLocaleString('ru')} / 5</p>
              )}
              {reading.review && (
                <p className="preserve-text">{reading.review}</p>
              )}
              <Button
                variant="quiet"
                className="book-detail-link"
                disabled={busy}
                onClick={() => {
                  onReading(reading);
                }}
              >
                Изменить план чтения
                {plans.length > 1 ? ` ${String(index + 1)}` : ''}
              </Button>
            </div>
          ))}
          <Button
            variant="quiet"
            className="book-detail-link"
            disabled={busy}
            onClick={onReread}
          >
            Добавить прочтение
          </Button>
        </section>
        <details className="book-disclosure">
          <summary>О книге</summary>
          <div className="form-stack">
            {book.description && (
              <p className="preserve-text">{book.description}</p>
            )}
            {book.genres.length > 0 && (
              <p className="caption">Жанры: {book.genres.join(', ')}</p>
            )}
            {book.isbn.length > 0 && (
              <p className="caption">ISBN: {book.isbn.join(', ')}</p>
            )}
            {book.language && <p className="caption">Язык: {book.language}</p>}
            {(book.publisher || book.publishedDate) && (
              <p className="caption">
                {book.publisher} · {book.publishedDate}
              </p>
            )}
            {book.catalogIds.map((ref) => (
              <p className="caption" key={`${ref.source}:${ref.value}`}>
                <a
                  href={
                    ref.source === 'google-books'
                      ? `https://books.google.com/books?id=${encodeURIComponent(ref.value)}`
                      : `https://openlibrary.org/books/${encodeURIComponent(ref.value)}`
                  }
                  target="_blank"
                  rel="noreferrer"
                >
                  {ref.source === 'google-books'
                    ? 'Google Books'
                    : 'Open Library'}{' '}
                </a>
              </p>
            ))}
          </div>
        </details>
        <Button variant="quiet" disabled={busy} onClick={onEdit}>
          Редактировать книгу
        </Button>
        <details className="book-disclosure">
          <summary>Файлы и издания</summary>
          <section className="form-stack" aria-label="Локальные файлы">
            {history.length > 1 && attached.some((file) => file.sha256) && (
              <SelectField
                label="Прочтение для чтения"
                value={currentReading?.id ?? ''}
                onChange={(event) => {
                  setSelectedReading(
                    event.target.value ? id(event.target.value) : null,
                  );
                }}
              >
                {history.map((reading) => (
                  <option key={reading.id} value={reading.id}>
                    {readingLabel(reading)} · {statusLabels[statusFor(reading)]}
                  </option>
                ))}
              </SelectField>
            )}
            {readable && (
              <Button variant="quiet" disabled={busy} onClick={onImport}>
                Прикрепить другое издание
              </Button>
            )}
            {attached.length === 0 ? (
              <p className="caption">
                Файл книги не прикреплён. Книга полноценно хранится в библиотеке
                без файла. Можно прикрепить EPUB или FB2 к этой записи.
              </p>
            ) : (
              attached.map((file) => (
                <div className="file-row" key={file.id}>
                  <span>{file.name}</span>
                  {file.sha256 && file.id !== readable?.id ? (
                    <Button
                      variant="quiet"
                      aria-label={`Читать файл ${file.name}`}
                      disabled={busy}
                      onClick={() => {
                        onRead(file.id, currentReading?.id);
                      }}
                    >
                      {positions.some(
                        (saved) =>
                          saved.readingId === currentReading?.id &&
                          saved.bookFileId === file.id,
                      )
                        ? 'Продолжить это издание'
                        : 'Читать это издание'}
                    </Button>
                  ) : !file.sha256 ? (
                    <p className="caption">
                      Повторно импортируйте этот файл, чтобы подготовить
                      проверенный индекс для чтения.
                    </p>
                  ) : null}
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      onRemoveFile(file.id);
                    }}
                  >
                    Убрать файл
                  </Button>
                </div>
              ))
            )}
          </section>
        </details>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <Button variant="danger" disabled={busy} onClick={onRemoveBook}>
          Удалить книгу
        </Button>
      </div>
    </Dialog>
  );
}
