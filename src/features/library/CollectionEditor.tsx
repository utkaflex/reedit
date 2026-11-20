import { useRef, useState } from 'react';
import { newId, type Book, type Collection, type Id } from '../../domain/model';
import { normalizeText } from '../../domain/library';
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
  pickingBooks = false,
}: {
  collection: Collection | undefined;
  books: Book[];
  store: LocalStore;
  onClose: () => void;
  onSaved: (id: Id) => Promise<void>;
  pickingBooks?: boolean;
}) {
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(() => new Set(collection?.bookIds));
  const terms = normalizeText(query).split(' ').filter(Boolean);
  const results = books.filter((book) => {
    const searchable = normalizeText([book.title, ...book.authors].join(' '));
    return terms.every((term) => searchable.includes(term));
  });
  const change = () => {
    setDirty(true);
    setError(null);
  };
  return (
    <EditorDialog
      title={
        pickingBooks
          ? 'Добавить книги'
          : collection
            ? 'Редактировать коллекцию'
            : 'Создать коллекцию'
      }
      onClose={onClose}
      dirty={dirty}
      busy={busy}
    >
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (lock.current) return;
          const values = new FormData(event.currentTarget);
          const name = values.get('name');
          const now = Math.max(Date.now(), (collection?.updatedAt ?? 0) + 1);
          const entity: Collection = {
            id: collection?.id ?? newId(),
            createdAt: collection?.createdAt ?? now,
            updatedAt: now,
            name:
              typeof name === 'string' ? name.trim() : (collection?.name ?? ''),
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
              await onSaved(entity.id);
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
          {pickingBooks ? (
            <p className="caption">{collection?.name}</p>
          ) : (
            <TextField
              label="Название коллекции"
              name="name"
              defaultValue={collection?.name ?? ''}
              required
              maxLength={200}
              onChange={change}
            />
          )}
          {books.length > 0 && (
            <TextField
              label="Поиск книг для коллекции"
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              placeholder="Название или автор"
            />
          )}
          <fieldset className="checkbox-list">
            <legend>Книги в коллекции</legend>
            {books.length > 0 && (
              <p role="status" className="caption">
                Выбрано: {selected.size}
              </p>
            )}
            {books.length === 0 && (
              <p className="caption">
                Пока нет книг. Их можно добавить в коллекцию позже.
              </p>
            )}
            {books.length > 0 && results.length === 0 && (
              <p className="caption">Ничего не найдено.</p>
            )}
            {results.map((book) => (
              <label key={book.id}>
                <input
                  type="checkbox"
                  checked={selected.has(book.id)}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setSelected((previous) => {
                      const next = new Set(previous);
                      if (checked) next.add(book.id);
                      else next.delete(book.id);
                      return next;
                    });
                    change();
                  }}
                />
                <span>
                  {book.title}
                  {book.authors.length > 0 && (
                    <small className="collection-book-authors">
                      {book.authors.join(', ')}
                    </small>
                  )}
                </span>
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
