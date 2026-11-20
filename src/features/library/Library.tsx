import type { CatalogProvider } from '../../domain/catalog';
import { CatalogSearch } from '../catalog/CatalogSearch';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Book, Collection, Id, Reading } from '../../domain/model';
import type { LibrarySnapshot, LocalStore } from '../../domain/repositories';
import {
  latestReading,
  readableEdition,
  selectBooks,
  statusLabels,
  type LibrarySort,
} from '../../domain/library';
import { Icon } from '../../ui/Icon';
import { ContinueReading } from './ContinueReading';
import { WeeklyReading } from './WeeklyReading';
import type { ReadingPosition } from '../../domain/model';
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
const sortLabels: Record<LibrarySort, string> = {
  newest: 'Сначала новые',
  title: 'По названию',
  author: 'По автору',
  rating: 'По оценке',
};
type LibraryFilters = {
  status: string;
  collectionId: string;
  sort: LibrarySort;
};
const defaultFilters: LibraryFilters = {
  status: 'all',
  collectionId: 'all',
  sort: 'newest',
};
export function Library({
  store,
  epubAdapter,
  catalogProviders,
}: {
  store: LocalStore;
  epubAdapter: EpubAdapter;
  catalogProviders: CatalogProvider[];
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [filters, setFilters] = useState(defaultFilters);
  const [filterDraft, setFilterDraft] = useState<
    (LibraryFilters & { view: 'grid' | 'list' }) | null
  >(null);
  const [storedPositions, setPositions] = useState<ReadingPosition[]>([]);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [importTarget, setImportTarget] = useState<Id | 'new' | null>(null);
  const [importFormat, setImportFormat] = useState<'epub' | 'fb2' | 'auto'>(
    'auto',
  );
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [selected, setSelected] = useState<Id | null>(null);
  const [bookEditor, setBookEditor] = useState<Book | 'new' | null>(null);
  const [readingEditor, setReadingEditor] = useState<Reading | null>(null);
  const [collectionsOpen, setCollectionsOpen] = useState(false);
  const collectionHeading = useRef<HTMLHeadingElement>(null);
  const [pickingCollectionBooks, setPickingCollectionBooks] = useState(false);
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
    return Promise.all([
      store.readLibrary(),
      store.repositories.positions.list(),
    ])
      .then(
        ([data, savedPositions]) => {
          if (mounted.current && token === generation.current) {
            setSnapshot(data);
            setPositions(savedPositions);
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
  const filesById = new Map(snapshot?.files.map((file) => [file.id, file]));
  const readingsById = new Map(
    snapshot?.readings.map((reading) => [reading.id, reading]),
  );
  const positions = storedPositions.filter((position) => {
    const file =
      position.bookFileId !== null
        ? filesById.get(position.bookFileId)
        : undefined;
    return (
      file?.sha256 &&
      file.bookId === readingsById.get(position.readingId)?.bookId &&
      (!position.cursor || position.cursor.sha256 === file.sha256)
    );
  });
  const { status, collectionId, sort } = filters;
  const selectedCollection = snapshot?.collections.find(
    (collection) => collection.id === collectionId,
  );
  const collectionIsEmpty =
    selectedCollection !== undefined &&
    !snapshot?.books.some((book) =>
      selectedCollection.bookIds.includes(book.id),
    );
  const goToShelf = (focusCollection: boolean) => {
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: 'instant' });
      if (focusCollection)
        collectionHeading.current?.focus({ preventScroll: true });
    });
  };
  const openCollection = (id: Id) => {
    setCollectionsOpen(false);
    setQuery('');
    setFilters({ ...defaultFilters, collectionId: id });
    goToShelf(true);
  };
  const books = snapshot
    ? selectBooks(snapshot.books, snapshot.readings, {
        query,
        status,
        sort,
        startedReadingIds: new Set(
          positions.map((position) => position.readingId),
        ),
        collectionBookIds: selectedCollection?.bookIds ?? null,
      })
    : [];
  const searching = query.trim().length > 0;
  const statusLabel =
    status === 'all' ? '' : statusLabels[status as Reading['status']];
  const appliedFilters = [
    statusLabel,
    sort !== 'newest' ? sortLabels[sort] : '',
  ].filter(Boolean);
  const hasBooks = Boolean(snapshot?.books.length);
  const collectionsButton = snapshot && (
    <Button
      className="library-collections-button"
      variant="secondary"
      aria-label="Коллекции"
      onClick={() => {
        setCollectionsOpen(true);
      }}
    >
      <Icon name="library" />
      <span>Коллекции</span>
    </Button>
  );
  const filterButton = hasBooks && (
    <Button
      className="library-filter-button"
      aria-label="Фильтры и сортировка"
      variant="secondary"
      onClick={() => {
        setFilterDraft({
          ...filters,
          collectionId: selectedCollection?.id ?? 'all',
          view,
        });
      }}
    >
      <Icon name="filter" />
      <span>Фильтры</span>
    </Button>
  );
  return (
    <div
      className={`library-feature${snapshot?.books.length === 0 ? ' library-feature--empty' : ''}${searching ? ' library-feature--searching' : ''}${searching && books.length === 0 ? ' library-feature--no-results' : ''}`}
    >
      <div className="library-actions">
        {snapshot && snapshot.books.length > 0 && (
          <TextField
            label="Поиск по библиотеке"
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            placeholder="Название, автор, жанр или ISBN"
          />
        )}
        {searching && filterButton}
        {(searching || !hasBooks) && collectionsButton}
        {hasBooks && (
          <Button
            className="library-add-button"
            aria-label="Добавить"
            disabled={!snapshot || Boolean(loadError)}
            onClick={() => {
              setAddOpen(true);
            }}
          >
            <Icon name="plus" />
            <span>Добавить</span>
          </Button>
        )}
      </div>
      {error && !selectedBook && (
        <p className="error-text" role="alert">
          {error} Повторите действие.
        </p>
      )}
      {hasBooks && snapshot && (
        <ContinueReading
          snapshot={snapshot}
          positions={positions}
          store={store}
          hidden={searching || Boolean(selectedCollection)}
          onRead={(bookId, fileId, readingId) => {
            window.location.hash = readerUrl({ bookId, fileId, readingId });
          }}
        />
      )}
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
        <div className="library-shelf">
          {selectedCollection && (
            <header className="collection-shelf-header">
              <Button
                variant="quiet"
                onClick={() => {
                  setFilters(defaultFilters);
                  setQuery('');
                  goToShelf(false);
                }}
              >
                <Icon name="back" /> Все книги
              </Button>
              <h2 tabIndex={-1} ref={collectionHeading}>
                {selectedCollection.name}
              </h2>
            </header>
          )}
          {hasBooks && (!searching || appliedFilters.length > 0) && (
            <div className="library-controls">
              {!searching && filterButton}
              {!searching && collectionsButton}
              {appliedFilters.length > 0 && (
                <div
                  className="active-filters"
                  role="group"
                  aria-label="Активные фильтры"
                >
                  <span>{appliedFilters.join(' · ')}</span>
                  <Button
                    variant="quiet"
                    onClick={() => {
                      setFilters(defaultFilters);
                      if (selectedCollection) goToShelf(false);
                    }}
                  >
                    Сбросить фильтры
                  </Button>
                </div>
              )}
              {!searching && (
                <div className="library-view-row">
                  <p role="status" className="caption">
                    {formatCount(books.length, ['книга', 'книги', 'книг'])} в
                    подборке
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
              )}
            </div>
          )}
          {books.length > 0 ? (
            <ul
              className={view === 'grid' ? 'book-grid' : 'book-list'}
              aria-label="Книги библиотеки"
            >
              {books.map((book) => {
                const reading = latestReading(snapshot.readings, book.id);
                const { file, position } = readableEdition(
                  snapshot.files,
                  positions,
                  book.id,
                  reading?.id,
                );
                return (
                  <LibraryCard
                    key={book.id}
                    book={book}
                    reading={reading}
                    hasPosition={Boolean(position)}
                    onRead={
                      file && !(selectedCollection && position)
                        ? () => {
                            void perform(async () => {
                              const activeReading =
                                reading ?? (await store.addReading(book.id));
                              window.location.hash = readerUrl({
                                bookId: book.id,
                                fileId: file.id,
                                readingId: activeReading.id,
                              });
                            });
                          }
                        : undefined
                    }
                    list={view === 'list'}
                    onOpen={() => {
                      setError(null);
                      setSelected(book.id);
                    }}
                  />
                );
              })}
            </ul>
          ) : selectedCollection && collectionIsEmpty ? (
            <div className="library-no-results collection-empty">
              <p>В коллекции пока нет книг.</p>
              <Button
                onClick={() => {
                  setPickingCollectionBooks(true);
                  setCollectionEditor(selectedCollection);
                }}
              >
                Добавить книги
              </Button>
            </div>
          ) : hasBooks ? (
            <div className="library-no-results">
              <h2 aria-live="polite">Ничего не найдено</h2>
              {searching && (
                <Button
                  variant="quiet"
                  onClick={() => {
                    setQuery('');
                  }}
                >
                  Очистить поиск
                </Button>
              )}
            </div>
          ) : (
            <div className="library-space">
              <EmptyState icon="book" title="Ваша первая книга">
                <p>Загрузите файл, чтобы начать читать.</p>
                <div className="empty-library-actions">
                  <Button
                    onClick={() => {
                      setImportFormat('auto');
                      setImportTarget('new');
                    }}
                  >
                    <Icon name="upload" />
                    Загрузить EPUB или FB2
                  </Button>
                  <div className="empty-library-choice">
                    <Button
                      variant="quiet"
                      onClick={() => {
                        setCatalogOpen(true);
                      }}
                    >
                      Найти в каталоге
                    </Button>
                    <p className="caption">Карточка без файла</p>
                  </div>
                  <div className="empty-library-choice">
                    <Button
                      variant="quiet"
                      onClick={() => {
                        setBookEditor('new');
                      }}
                    >
                      Добавить вручную
                    </Button>
                    <p className="caption">Для бумажной книги</p>
                  </div>
                </div>
              </EmptyState>
            </div>
          )}
        </div>
      )}
      {hasBooks && !searching && !selectedCollection && (
        <WeeklyReading store={store} />
      )}
      {filterDraft && snapshot && (
        <Dialog
          open
          presentation="panel"
          title="Фильтры и сортировка"
          onClose={() => {
            setFilterDraft(null);
          }}
          footer={
            <Button
              onClick={() => {
                const { view: nextView, ...nextFilters } = filterDraft;
                setFilters(nextFilters);
                setView(nextView);
                setFilterDraft(null);
                if (nextFilters.collectionId !== collectionId)
                  goToShelf(nextFilters.collectionId !== 'all');
              }}
            >
              Показать книги
            </Button>
          }
        >
          <div className="filter-fields">
            <div className="mobile-library-view">
              <SegmentedControl
                label="Вид библиотеки"
                value={filterDraft.view}
                options={[
                  { value: 'grid', label: 'Сетка' },
                  { value: 'list', label: 'Список' },
                ]}
                onChange={(view) => {
                  setFilterDraft({ ...filterDraft, view });
                }}
              />
            </div>
            <SelectField
              label="Статус книги"
              value={filterDraft.status}
              onChange={(event) => {
                setFilterDraft({ ...filterDraft, status: event.target.value });
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
              value={filterDraft.collectionId}
              onChange={(event) => {
                setFilterDraft({
                  ...filterDraft,
                  collectionId: event.target.value,
                });
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
              value={filterDraft.sort}
              onChange={(event) => {
                const value = event.target.value;
                if (
                  value === 'newest' ||
                  value === 'title' ||
                  value === 'author' ||
                  value === 'rating'
                )
                  setFilterDraft({ ...filterDraft, sort: value });
              }}
            >
              {Object.entries(sortLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </SelectField>
          </div>
        </Dialog>
      )}
      {addOpen && (
        <Dialog
          open
          presentation="panel"
          title="Добавить в библиотеку"
          onClose={() => {
            setAddOpen(false);
          }}
        >
          <div className="add-choices">
            <Button
              variant="quiet"
              onClick={() => {
                setAddOpen(false);
                setImportFormat('auto');
                setImportTarget('new');
              }}
            >
              <Icon name="upload" />
              <span>
                <strong>Загрузить EPUB или FB2</strong>
                <small>С устройства · файл останется у вас</small>
              </span>
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                setAddOpen(false);
                setCatalogOpen(true);
              }}
            >
              <Icon name="search" />
              <span>
                <strong>Найти в каталоге</strong>
                <small>Карточка по названию, автору или ISBN · без файла</small>
              </span>
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                setAddOpen(false);
                setBookEditor('new');
              }}
            >
              <Icon name="book" />
              <span>
                <strong>Добавить вручную</strong>
                <small>В том числе бумажную книгу</small>
              </span>
            </Button>
          </div>
        </Dialog>
      )}
      {selectedBook &&
        !confirmation &&
        !bookEditor &&
        !readingEditor &&
        !importTarget && (
          <BookView
            book={selectedBook}
            readings={snapshot?.readings ?? []}
            files={snapshot?.files ?? []}
            positions={positions}
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
            onImport={() => {
              setImportFormat('auto');
              setImportTarget(selectedBook.id);
              setSelected(null);
            }}
            onRead={(fileId, readingId) => {
              void perform(async () => {
                const activeId =
                  readingId ?? (await store.addReading(selectedBook.id)).id;
                // Remove the native modal backdrop before iOS samples the reader's status-bar tint.
                for (const dialog of document.querySelectorAll<HTMLDialogElement>(
                  'dialog[open]',
                ))
                  dialog.close();
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
                <Button
                  variant="quiet"
                  className="collection-open"
                  onClick={() => {
                    openCollection(collection.id);
                  }}
                >
                  {collection.name}
                </Button>
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
          pickingBooks={pickingCollectionBooks}
          onClose={() => {
            setCollectionEditor(null);
            setPickingCollectionBooks(false);
            if (!pickingCollectionBooks) setCollectionsOpen(true);
          }}
          onSaved={async (id) => {
            await reload();
            setCollectionEditor(null);
            setPickingCollectionBooks(false);
            openCollection(id);
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
          onSaved={async (id, openFile) => {
            if (openFile) {
              try {
                const [data, saved] = await Promise.all([
                  store.readLibrary(),
                  store.repositories.positions.list(),
                ]);
                const file = data.files.find((file) => file.id === openFile);
                const history = data.readings.filter(
                  (reading) => reading.bookId === id,
                );
                const resume = saved
                  .filter(
                    (position) =>
                      position.bookFileId === openFile &&
                      (!position.cursor ||
                        position.cursor.sha256 === file?.sha256),
                  )
                  .sort((a, b) => b.updatedAt - a.updatedAt)
                  .map((position) =>
                    history.find(
                      (reading) => reading.id === position.readingId,
                    ),
                  )
                  .find(Boolean);
                const reading =
                  resume ??
                  latestReading(history, id) ??
                  (await store.addReading(id));
                document
                  .querySelector<HTMLDialogElement>(
                    'dialog.import-dialog[open]',
                  )
                  ?.close();
                setImportTarget(null);
                window.location.hash = readerUrl({
                  bookId: id,
                  fileId: openFile,
                  readingId: reading.id,
                });
                return;
              } catch (reason) {
                setError(
                  reason instanceof Error
                    ? reason.message
                    : 'Не удалось открыть файл.',
                );
              }
            }
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
                      setFilters((current) => ({
                        ...current,
                        collectionId: 'all',
                      }));
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
