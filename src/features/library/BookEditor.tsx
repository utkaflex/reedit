import { useRef, useState, type SyntheticEvent } from 'react';
import type { Book, Id } from '../../domain/model';
import type { LocalStore } from '../../domain/repositories';
import { DuplicateBookError } from '../../domain/library';
import { makeBook, initialReading } from '../../services/library';
import { Button } from '../../ui/Button';
import { TextField } from '../../ui/TextField';
import { TextArea } from '../../ui/FormControls';
import { useBlobUrl } from '../../ui/useBlobUrl';
import { copyCover } from '../../infrastructure/cover';
import { EditorDialog } from './EditorDialog';

export function BookEditor({
  book,
  store,
  onClose,
  onSaved,
  onOpenDuplicate,
}: {
  book: Book | undefined;
  store: LocalStore;
  onClose: () => void;
  onSaved: (id: Id) => Promise<void>;
  onOpenDuplicate: (id: Id) => void;
}) {
  const [cover, setCover] = useState(book?.cover ?? null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<Id[]>([]);
  const form = useRef<HTMLFormElement>(null);
  const url = useBlobUrl(cover);
  const save = async (allowDuplicate: boolean) => {
    if (lock.current || !form.current?.reportValidity()) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const values = new FormData(form.current);
      const text = (name: string) => {
        const value = values.get(name);
        return typeof value === 'string' ? value : '';
      };
      const entity = makeBook(
        {
          title: text('title'),
          authors: text('authors'),
          description: text('description'),
          genres: text('genres'),
          publisher: text('publisher'),
          publishedDate: text('publishedDate'),
          isbn: text('isbn'),
          cover,
        },
        book,
      );
      const options = {
        expectedUpdatedAt: book?.updatedAt ?? null,
        allowDuplicate,
        ...(!book ? { initialReading: initialReading(entity) } : {}),
      };
      await store.saveLibraryBook(entity, options);
      await onSaved(entity.id);
    } catch (reason) {
      if (reason instanceof DuplicateBookError) setDuplicates(reason.bookIds);
      setError(
        reason instanceof Error
          ? reason.message
          : 'Не удалось сохранить книгу.',
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const upload = async (file: File | undefined) => {
    if (!file || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      setCover(await copyCover(file));
      setDirty(true);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Не удалось прочитать обложку.',
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void save(false);
  };
  return (
    <EditorDialog
      title={book ? 'Редактировать книгу' : 'Добавить книгу'}
      onClose={onClose}
      dirty={dirty}
      busy={busy}
    >
      <form
        ref={form}
        onSubmit={submit}
        onChange={() => {
          setDirty(true);
          setDuplicates([]);
          setError(null);
        }}
        className="form-stack"
        aria-busy={busy}
      >
        <fieldset disabled={busy} className="form-stack form-fieldset">
          <TextField
            label="Название"
            name="title"
            defaultValue={book?.title ?? ''}
            required
            maxLength={500}
          />
          <TextField
            label="Автор"
            name="authors"
            defaultValue={book?.authors.join('; ') ?? ''}
            hint="Несколько авторов — через точку с запятой"
            maxLength={2000}
          />
          <div className="field">
            <label htmlFor="cover-upload">Обложка</label>
            <input
              id="cover-upload"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => {
                void upload(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            <p className="caption">
              JPG, PNG или WebP, до 10 МБ. Сохраняется локальная копия.
            </p>
            {url && (
              <img
                className="cover-preview"
                src={url}
                alt="Предпросмотр обложки"
              />
            )}
            {cover && (
              <Button
                variant="quiet"
                onClick={() => {
                  setCover(null);
                  setDirty(true);
                }}
              >
                Убрать обложку
              </Button>
            )}
          </div>
          <TextArea
            label="Описание"
            name="description"
            defaultValue={book?.description ?? ''}
            maxLength={30000}
          />
          <TextField
            label="Жанры"
            name="genres"
            defaultValue={book?.genres.join(', ') ?? ''}
            hint="Через запятую"
            maxLength={2000}
          />
          <TextField
            label="Издательство"
            name="publisher"
            defaultValue={book?.publisher ?? ''}
            maxLength={500}
          />
          <TextField
            label="Год или дата издания"
            name="publishedDate"
            defaultValue={book?.publishedDate ?? ''}
            maxLength={100}
          />
          <TextField
            label="ISBN (необязательно)"
            name="isbn"
            defaultValue={book?.isbn.join(', ') ?? ''}
            maxLength={200}
          />
        </fieldset>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        {duplicates.length > 0 && (
          <div className="duplicate-notice form-stack">
            <p>
              Можно открыть существующую книгу или явно добавить отдельный
              экземпляр. Записи не объединяются автоматически.
            </p>
            <Button
              disabled={busy}
              variant="secondary"
              onClick={() => {
                const id = duplicates[0];
                if (id) onOpenDuplicate(id);
              }}
            >
              Открыть существующую книгу
            </Button>
            <Button
              disabled={busy}
              variant="secondary"
              onClick={() => {
                void save(true);
              }}
            >
              Сохранить отдельную запись
            </Button>
          </div>
        )}
        <div className="form-actions">
          <Button type="submit" disabled={busy}>
            {busy
              ? 'Сохраняем…'
              : book
                ? 'Сохранить изменения'
                : 'Добавить в библиотеку'}
          </Button>
        </div>
      </form>
    </EditorDialog>
  );
}
