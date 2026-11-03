import { useRef, useState } from 'react';
import { newId, type Book, type Collection } from '../../domain/model';
import type { LocalStore } from '../../domain/repositories';
import { TextField } from '../../ui/TextField';
import { Button } from '../../ui/Button';
import { EditorDialog } from './EditorDialog';

export function CollectionEditor({
  collection,
  books,
  store,
  onClose,
  onSaved,
}: {
  collection: Collection | undefined;
  books: Book[];
  store: LocalStore;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <EditorDialog
      title={collection ? 'Редактировать коллекцию' : 'Создать коллекцию'}
      onClose={onClose}
      dirty={dirty}
      busy={busy}
    >
      <form
        className="form-stack"
        onChange={() => {
          setDirty(true);
          setError(null);
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (lock.current) return;
          const values = new FormData(event.currentTarget);
          const name = values.get('name');
          const selected = new Set(values.getAll('books'));
          const now = Math.max(Date.now(), (collection?.updatedAt ?? 0) + 1);
          const entity: Collection = {
            id: collection?.id ?? newId(),
            createdAt: collection?.createdAt ?? now,
            updatedAt: now,
            name: typeof name === 'string' ? name.trim() : '',
            bookIds: books
              .filter((book) => selected.has(book.id))
              .map((book) => book.id),
          };
          lock.current = true;
          setBusy(true);
          setError(null);
          void (async () => {
            try {
              await store.repositories.collections.save(entity, {
                expectedUpdatedAt: collection?.updatedAt ?? null,
              });
              await onSaved();
            } catch (reason) {
              setError(
                reason instanceof Error
                  ? reason.message
                  : 'Не удалось сохранить коллекцию.',
              );
            } finally {
              lock.current = false;
              setBusy(false);
            }
          })();
        }}
      >
        <fieldset disabled={busy} className="form-stack form-fieldset">
          <TextField
            label="Название коллекции"
            name="name"
            defaultValue={collection?.name ?? ''}
            required
            maxLength={200}
          />
          <fieldset className="checkbox-list">
            <legend>Книги в коллекции</legend>
            {books.length === 0 && (
              <p className="caption">
                Пока нет книг. Их можно добавить в коллекцию позже.
              </p>
            )}
            {books.map((book) => (
              <label key={book.id}>
                <input
                  type="checkbox"
                  name="books"
                  value={book.id}
                  defaultChecked={
                    collection?.bookIds.includes(book.id) ?? false
                  }
                />
                <span>{book.title}</span>
              </label>
            ))}
          </fieldset>
        </fieldset>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy}>
          {busy ? 'Сохраняем…' : 'Сохранить коллекцию'}
        </Button>
      </form>
    </EditorDialog>
  );
}
