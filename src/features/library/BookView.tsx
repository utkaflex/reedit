import {
  id,
  type Book,
  type Reading,
  type BookFileSummary,
  type Id,
} from '../../domain/model';
import { useState } from 'react';
import { dateInput, statusLabels } from '../../domain/library';
import { useBlobUrl } from '../../ui/useBlobUrl';
import { BookCard } from '../../ui/BookCard';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { formatCount } from '../../ui/format';
import { SelectField } from '../../ui/FormControls';

export function LibraryCard({
  book,
  reading,
  onOpen,
  list,
}: {
  book: Book;
  reading: Reading | undefined;
  onOpen: () => void;
  list: boolean;
}) {
  const url = useBlobUrl(book.cover);
  return (
    <li
      data-book-id={book.id}
      className={list ? 'library-list-item' : 'library-grid-item'}
    >
      <BookCard
        title={book.title}
        authors={book.authors}
        {...(url ? { coverUrl: url } : {})}
        onOpen={onOpen}
      />
      <p className="book-status">
        {statusLabels[reading?.status ?? 'planned']}
        {reading?.rating ? ` · ${reading.rating.toLocaleString('ru')} / 5` : ''}
      </p>
    </li>
  );
}
export function BookView({
  book,
  readings,
  files,
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
  onClose: () => void;
  onEdit: () => void;
  onReading: (reading: Reading) => void;
  onReread: () => void;
  onImport: (format: 'epub' | 'fb2') => void;
  onRead: (fileId: Id, readingId: Id | undefined) => void;
  onRemoveBook: () => void;
  onRemoveFile: (id: Id) => void;
  busy: boolean;
  error: string | null;
}) {
  const url = useBlobUrl(book.cover);
  const history = readings
    .filter((reading) => reading.bookId === book.id)
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  const attached = files.filter((file) => file.bookId === book.id);
  const [selectedReading, setSelectedReading] = useState<Id | null>(null);
  const currentReading =
    history.find((reading) => reading.id === selectedReading) ?? history[0];
  return (
    <Dialog
      open
      title={book.title}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="form-stack book-detail">
        {url && (
          <img
            className="cover-preview"
            src={url}
            alt={`Обложка «${book.title}»`}
          />
        )}
        <p>{book.authors.join(', ') || 'Автор не указан'}</p>
        <a
          className="button button--secondary"
          href={`#/quotes?book=${book.id}`}
        >
          Цитаты, заметки и закладки книги
        </a>
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
              {ref.source === 'google-books' ? 'Google Books' : 'Open Library'}{' '}
              · {ref.value}
            </a>
          </p>
        ))}
        <Button variant="secondary" disabled={busy} onClick={onEdit}>
          Редактировать книгу
        </Button>
        <section className="form-stack" aria-label="История чтения">
          <div className="section-heading">
            <h3>История чтения</h3>
            <span className="caption">
              {formatCount(history.length, [
                'прочтение',
                'прочтения',
                'прочтений',
              ])}
            </span>
          </div>
          {history.length === 0 && (
            <p className="caption">Прочтений пока нет.</p>
          )}
          {history.map((reading, index) => (
            <article className="reading-entry form-stack" key={reading.id}>
              <h4>
                Прочтение {history.length - index} ·{' '}
                {statusLabels[reading.status]}
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
                Изменить прочтение {history.length - index}
              </Button>
            </article>
          ))}
          <Button disabled={busy} onClick={onReread}>
            Добавить прочтение
          </Button>
          <p className="caption">
            Будет создано отдельное прочтение. Прежние оценки, отзывы и даты
            сохранятся.
          </p>
        </section>
        <section className="form-stack" aria-label="Локальные файлы">
          <h3>Файлы книги</h3>
          {attached.some((file) => file.sha256) && (
            <SelectField
              label="Прочтение для чтения"
              value={currentReading?.id ?? ''}
              onChange={(event) => {
                setSelectedReading(
                  event.target.value ? id(event.target.value) : null,
                );
              }}
            >
              {history.length === 0 && (
                <option value="">Первое прочтение</option>
              )}
              {history.map((reading, number) => (
                <option key={reading.id} value={reading.id}>
                  Прочтение {history.length - number} ·{' '}
                  {statusLabels[reading.status]}
                </option>
              ))}
            </SelectField>
          )}
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              onImport('epub');
            }}
          >
            Прикрепить EPUB
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              onImport('fb2');
            }}
          >
            Прикрепить FB2
          </Button>
          {attached.length === 0 ? (
            <p className="caption">
              Файл книги не прикреплён. Книга полноценно хранится в библиотеке
              без файла. Можно прикрепить EPUB или FB2 к этой записи.
            </p>
          ) : (
            attached.map((file) => (
              <div className="file-row" key={file.id}>
                <span>{file.name}</span>
                {file.sha256 ? (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      onRead(file.id, currentReading?.id);
                    }}
                  >
                    Читать файл {file.name}
                  </Button>
                ) : (
                  <p className="caption">
                    Повторно импортируйте этот файл, чтобы подготовить
                    проверенный индекс для чтения.
                  </p>
                )}
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
