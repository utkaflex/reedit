import type { CatalogProvider } from '../../domain/catalog';
import { CatalogSearch } from '../catalog/CatalogSearch';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Book, Collection, Id, Reading } from '../../domain/model';
import type { LibrarySnapshot, LocalStore } from '../../domain/repositories';
import {
  latestReading,
  selectBooks,
  statusLabels,
  type LibrarySort,
} from '../../domain/library';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { EmptyState } from '../../ui/EmptyState';
import { SelectField } from '../../ui/FormControls';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { TextField } from '../../ui/TextField';
import { BookEditor } from './BookEditor';
import { BookView, LibraryCard } from './BookView';
import { CollectionEditor } from './CollectionEditor';
import { ReadingEditor } from './ReadingEditor';
import './library.css';
import { formatCount } from '../../ui/format';
import type { EpubAdapter } from '../../domain/epub';
import { EpubImportDialog } from './EpubImportDialog';
import { readerUrl } from '../shell/navigation';

type Confirmation =
  | { type: 'book'; id: Id; title: string }
  | { type: 'file'; id: Id; bookId: Id; format: 'EPUB' | 'FB2' }
  | { type: 'collection'; id: Id; title: string };
export function Library({
  store,
  epubAdapter,
  catalogProviders,
}: {
  store: LocalStore;
  epubAdapter: EpubAdapter;
  catalogProviders: CatalogProvider[];
}) {
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [importTarget, setImportTarget] = useState<Id | 'new' | null>(null);
  const [importFormat, setImportFormat] = useState<'epub' | 'fb2'>('epub');
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [collectionId, setCollectionId] = useState('all');
  const [sort, setSort] = useState<LibrarySort>('newest');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [selected, setSelected] = useState<Id | null>(null);
  const [bookEditor, setBookEditor] = useState<Book | 'new' | null>(null);
  const [readingEditor, setReadingEditor] = useState<Reading | null>(null);
  const [collectionsOpen, setCollectionsOpen] = useState(false);
  const [collectionEditor, setCollectionEditor] = useState<
    Collection | 'new' | null
  >(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const reload = useCallback(() => {
    const token = ++generation.current;
    return store
      .readLibrary()
      .then(
        (data) => {
          if (mounted.current && token === generation.current) {
            setSnapshot(data);
            setLoadError(null);
          }
        },
        (reason: unknown) => {
          if (mounted.current && token === generation.current)
            setLoadError(
              reason instanceof Error
                ? reason.message
                : 'Не удалось загрузить библиотеку.',
            );
        },
      )
      .finally(() => {
        if (mounted.current && token === generation.current)
          setRefreshing(false);
      });
  }, [store]);
  useEffect(() => {
    mounted.current = true;
    void reload();
    const onFocus = () => {
      setRefreshing(true);
      void reload();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      mounted.current = false;
      window.removeEventListener('focus', onFocus);
    };
  }, [reload]);
  const perform = async (action: () => Promise<unknown>, done?: () => void) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
      done?.();
      await reload();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Операция не выполнена. Повторите попытку.',
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const selectedBook = snapshot?.books.find((book) => book.id === selected);
  const selectedCollection = snapshot?.collections.find(
    (collection) => collection.id === collectionId,
  );
  const books = snapshot
    ? selectBooks(snapshot.books, snapshot.readings, {
        query,
        status,
        sort,
        collectionBookIds: selectedCollection?.bookIds ?? null,
      })
    : [];
  return (
    <div className="library-feature">
      <div className="library-actions">
        <p className="caption">
          {snapshot
            ? `${formatCount(snapshot.books.length, ['книга', 'книги', 'книг'])} · на этом устройстве`
            : 'Личная библиотека'}
        </p>
        <div className="action-row">
          <Button
            variant="secondary"
            disabled={!snapshot || Boolean(loadError)}
            onClick={() => {
              setCatalogOpen(true);
            }}
          >
            Найти в каталогах
          </Button>
          <Button
            variant="secondary"
            disabled={!snapshot || Boolean(loadError)}
            onClick={() => {
              setImportFormat('epub');
              setImportTarget('new');
            }}
          >
            Импорт EPUB
          </Button>
          <Button
            variant="secondary"
            disabled={!snapshot || Boolean(loadError)}
            onClick={() => {
              setImportFormat('fb2');
              setImportTarget('new');
            }}
          >
            Импорт FB2
          </Button>
          <Button
            variant="secondary"
            disabled={!snapshot || Boolean(loadError)}
            onClick={() => {
              setCollectionsOpen(true);
            }}
          >
            Коллекции
          </Button>
          <Button
            disabled={!snapshot || Boolean(loadError)}
            onClick={() => {
              setBookEditor('new');
            }}
          >
            Добавить книгу
          </Button>
        </div>
      </div>
      {loadError && (
        <div className="surface form-stack error-surface">
          <p role="alert">{loadError}</p>
          <p className="caption">
            Сохранённые данные не удалены. Показанная библиотека может быть
            устаревшей.
          </p>
          <Button
            variant="secondary"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true);
              void reload();
            }}
          >
            Обновить библиотеку
          </Button>
        </div>
      )}
      {!snapshot && !loadError && <p role="status">Загружаем библиотеку…</p>}
      {snapshot && (
        <>
          <div className="library-toolbar">
            <TextField
              label="Поиск по библиотеке"
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              placeholder="Название, автор, жанр или ISBN"
            />
            <details className="library-filters">
              <summary>
                Фильтры и сортировка
                {(status !== 'all' ||
                  selectedCollection ||
                  sort !== 'newest') && (
                  <span className="caption"> · применены</span>
                )}
              </summary>
              <div className="filter-fields">
                <SelectField
                  label="Статус книги"
                  value={status}
                  onChange={(event) => {
                    setStatus(event.target.value);
                  }}
                >
                  <option value="all">Все статусы</option>
                  {Object.entries(statusLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </SelectField>
                <SelectField
                  label="Коллекция"
                  value={selectedCollection?.id ?? 'all'}
                  onChange={(event) => {
                    setCollectionId(event.target.value);
                  }}
                >
                  <option value="all">Все книги</option>
                  {snapshot.collections.map((collection) => (
                    <option key={collection.id} value={collection.id}>
                      {collection.name}
                    </option>
                  ))}
                </SelectField>
                <SelectField
                  label="Сортировка"
                  value={sort}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (
                      value === 'newest' ||
                      value === 'title' ||
                      value === 'author' ||
                      value === 'rating'
                    )
                      setSort(value);
                  }}
                >
                  <option value="newest">Сначала новые</option>
                  <option value="title">По названию</option>
                  <option value="author">По автору</option>
                  <option value="rating">По оценке</option>
                </SelectField>
              </div>
            </details>
          </div>
          <div className="library-view-row">
            <p role="status" className="caption">
              {formatCount(books.length, ['книга', 'книги', 'книг'])} в подборке
              {refreshing ? ' · Обновляем…' : ''}
            </p>
            <SegmentedControl
              label="Вид библиотеки"
              value={view}
              options={[
                { value: 'grid', label: 'Сетка' },
                { value: 'list', label: 'Список' },
              ]}
              onChange={setView}
            />
          </div>
          {books.length > 0 ? (
            <ul
              className={view === 'grid' ? 'book-grid' : 'book-list'}
              aria-label="Книги библиотеки"
            >
              {books.map((book) => (
                <LibraryCard
                  key={book.id}
                  book={book}
                  reading={latestReading(snapshot.readings, book.id)}
                  list={view === 'list'}
                  onOpen={() => {
                    setError(null);
                    setSelected(book.id);
                  }}
                />
              ))}
            </ul>
          ) : (
            <div className="library-space">
              <EmptyState
                icon="book"
                title={
                  snapshot.books.length === 0
                    ? 'Первая книга — начало истории'
                    : 'Ничего не найдено'
                }
              >
                <p>
                  {snapshot.books.length === 0
                    ? 'Добавьте книгу вручную. EPUB или FB2 можно прикрепить к ней в любое время.'
                    : 'Попробуйте изменить поиск, статус или коллекцию.'}
                </p>
                {snapshot.books.length > 0 && (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setQuery('');
                      setStatus('all');
                      setCollectionId('all');
                    }}
                  >
                    Сбросить поиск и фильтры
                  </Button>
                )}
              </EmptyState>
            </div>
          )}
        </>
      )}
      {selectedBook && !confirmation && (
        <BookView
          book={selectedBook}
          readings={snapshot?.readings ?? []}
          files={snapshot?.files ?? []}
          onClose={() => {
            const id = selectedBook.id;
            setSelected(null);
            requestAnimationFrame(() => {
              document
                .querySelector<HTMLElement>(`[data-book-id="${id}"] button`)
                ?.focus({ preventScroll: true });
            });
          }}
          busy={busy}
          error={error}
          onEdit={() => {
            setBookEditor(selectedBook);
            setSelected(null);
          }}
          onReading={(reading) => {
            setReadingEditor(reading);
            setSelected(null);
          }}
          onReread={() => {
            void perform(() => store.addReading(selectedBook.id));
          }}
          onImport={(format) => {
            setImportFormat(format);
            setImportTarget(selectedBook.id);
            setSelected(null);
          }}
          onRead={(fileId, readingId) => {
            void perform(async () => {
              const activeId =
                readingId ?? (await store.addReading(selectedBook.id)).id;
              setSelected(null);
              window.location.hash = readerUrl({
                bookId: selectedBook.id,
                fileId,
                readingId: activeId,
              });
            });
          }}
          onRemoveBook={() => {
            setError(null);
            setConfirmation({
              type: 'book',
              id: selectedBook.id,
              title: selectedBook.title,
            });
          }}
          onRemoveFile={(id) => {
            setError(null);
            setConfirmation({
              type: 'file',
              id,
              bookId: selectedBook.id,
              format:
                snapshot?.files.find((file) => file.id === id)?.mediaType ===
                'application/x-fictionbook+xml'
                  ? 'FB2'
                  : 'EPUB',
            });
          }}
        />
      )}
      {selected && snapshot && !selectedBook && !confirmation && (
        <Dialog
          open
          title="Книга недоступна"
          onClose={() => {
            setSelected(null);
          }}
        >
          <p>Книга могла быть удалена в другой вкладке.</p>
          <Button
            variant="secondary"
            onClick={() => {
              setSelected(null);
            }}
          >
            К библиотеке
          </Button>
        </Dialog>
      )}
      {bookEditor && (
        <BookEditor
          book={bookEditor === 'new' ? undefined : bookEditor}
          store={store}
          onClose={() => {
            setBookEditor(null);
          }}
          onSaved={async (id) => {
            await reload();
            setBookEditor(null);
            setSelected(id);
          }}
          onOpenDuplicate={(id) => {
            setBookEditor(null);
            setSelected(id);
          }}
        />
      )}
      {readingEditor && (
        <ReadingEditor
          reading={readingEditor}
          store={store}
          onClose={() => {
            setSelected(readingEditor.bookId);
            setReadingEditor(null);
          }}
          onSaved={async () => {
            await reload();
            setSelected(readingEditor.bookId);
            setReadingEditor(null);
          }}
        />
      )}
      {collectionsOpen && snapshot && !confirmation && (
        <Dialog
          open
          title="Коллекции"
          onClose={() => {
            setCollectionsOpen(false);
          }}
        >
          <div className="form-stack">
            <p className="caption">
              Коллекции ссылаются на книги, не создавая их копий.
            </p>
            <Button
              onClick={() => {
                setCollectionsOpen(false);
                setCollectionEditor('new');
              }}
            >
              Создать коллекцию
            </Button>
            {snapshot.collections.length === 0 && <p>Коллекций пока нет.</p>}
            {snapshot.collections.map((collection) => (
              <div className="collection-row form-stack" key={collection.id}>
                <h3>{collection.name}</h3>
                <p className="caption">
                  {formatCount(collection.bookIds.length, [
                    'книга',
                    'книги',
                    'книг',
                  ])}
                </p>
                <div className="action-row">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setCollectionsOpen(false);
                      setCollectionEditor(collection);
                    }}
                  >
                    Редактировать «{collection.name}»
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => {
                      setError(null);
                      setConfirmation({
                        type: 'collection',
                        id: collection.id,
                        title: collection.name,
                      });
                    }}
                  >
                    Удалить коллекцию «{collection.name}»
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Dialog>
      )}
      {collectionEditor && snapshot && (
        <CollectionEditor
          collection={collectionEditor === 'new' ? undefined : collectionEditor}
          books={snapshot.books}
          store={store}
          onClose={() => {
            setCollectionEditor(null);
            setCollectionsOpen(true);
          }}
          onSaved={async () => {
            await reload();
            setCollectionEditor(null);
            setCollectionsOpen(true);
          }}
        />
      )}
      {catalogOpen && snapshot && (
        <CatalogSearch
          store={store}
          providers={catalogProviders}
          books={snapshot.books}
          onClose={() => {
            setCatalogOpen(false);
          }}
          onSaved={async (bookId) => {
            await reload();
            setCatalogOpen(false);
            setSelected(bookId);
          }}
        />
      )}
      {importTarget && snapshot && (
        <EpubImportDialog
          format={importFormat}
          adapter={epubAdapter}
          store={store}
          books={snapshot.books}
          target={importTarget === 'new' ? null : importTarget}
          onClose={() => {
            if (importTarget !== 'new') setSelected(importTarget);
            setImportTarget(null);
          }}
          onSaved={async (id) => {
            await reload();
            setImportTarget(null);
            setSelected(id);
          }}
        />
      )}
      {confirmation && (
        <Dialog
          open
          title={
            confirmation.type === 'file'
              ? `Убрать файл ${confirmation.format}?`
              : confirmation.type === 'book'
                ? 'Удалить книгу?'
                : 'Удалить коллекцию?'
          }
          onClose={() => {
            if (!busy) setConfirmation(null);
          }}
        >
          <div className="form-stack">
            <p>
              {confirmation.type === 'book'
                ? `«${confirmation.title}»: книга, файлы и вся история чтения, включая отзывы, закладки, заметки, дневник и статистику, будут удалены с устройства. Это действие нельзя отменить.`
                : confirmation.type === 'file'
                  ? 'Будут удалены локальный оригинал и его представление для чтения. Книга, прочтения, заметки, закладки, дневник и статистика сохранятся.'
                  : `Коллекция «${confirmation.title}» будет удалена. Все книги останутся в библиотеке.`}
            </p>
            {error && (
              <p role="alert" className="error-text">
                {error}
              </p>
            )}
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                const action = confirmation;
                void perform(
                  () =>
                    action.type === 'book'
                      ? store.removeBook(action.id, { confirmed: true })
                      : action.type === 'file'
                        ? store.removeBookFile(action.id)
                        : store.removeCollection(action.id, {
                            confirmed: true,
                          }),
                  () => {
                    setConfirmation(null);
                    if (action.type === 'book') setSelected(null);
                    if (
                      action.type === 'collection' &&
                      collectionId === action.id
                    )
                      setCollectionId('all');
                  },
                );
              }}
            >
              {busy
                ? 'Удаляем…'
                : confirmation.type === 'file'
                  ? 'Убрать только файл'
                  : confirmation.type === 'book'
                    ? 'Удалить книгу навсегда'
                    : 'Подтвердить удаление коллекции'}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setConfirmation(null);
              }}
            >
              Отмена
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
