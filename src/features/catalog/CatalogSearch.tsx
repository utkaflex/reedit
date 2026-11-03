import { useEffect, useRef, useState } from 'react';
import {
  catalogMatches,
  type CatalogBook,
  type CatalogEdition,
  type CatalogPage,
  type CatalogProvider,
  type CatalogQuery,
} from '../../domain/catalog';
import { type Book, type Id } from '../../domain/model';
import type { LocalStore } from '../../domain/repositories';
import { DuplicateBookError } from '../../domain/library';
import { saveCatalogSelection } from '../../services/catalog';
import type { BookDraft } from '../../services/library';
import { copyCatalogCover } from '../../infrastructure/catalog/covers';
import { coverUrl } from '../../infrastructure/catalog/providers';
import { copyCover } from '../../infrastructure/cover';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { SelectField, TextArea } from '../../ui/FormControls';
import { TextField } from '../../ui/TextField';
import { useBlobUrl } from '../../ui/useBlobUrl';
import './catalog.css';

function Cover({ url, title }: { url: string | undefined; title: string }) {
  const [failed, setFailed] = useState(false);
  return url && !failed ? (
    <img
      className="catalog-cover"
      src={url}
      alt={`Обложка «${title}»`}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => {
        setFailed(true);
      }}
    />
  ) : (
    <div
      className="catalog-cover catalog-cover--empty"
      aria-label="Нет обложки"
    >
      {title}
    </div>
  );
}
function Source({ book }: { book: CatalogBook }) {
  return (
    <a href={book.url} target="_blank" rel="noreferrer">
      {book.source === 'google-books' ? 'Google Books' : 'Open Library'} ·{' '}
      {book.id}
    </a>
  );
}
const blankDraft: BookDraft = {
  title: '',
  authors: '',
  description: '',
  genres: '',
  isbn: '',
  cover: null,
};
export function CatalogSearch({
  store,
  providers,
  books,
  onClose,
  onSaved,
}: {
  store: LocalStore;
  providers: CatalogProvider[];
  books: Book[];
  onClose: () => void;
  onSaved: (id: Id) => Promise<void>;
}) {
  const [source, setSource] = useState('open-library');
  const provider = providers.find((item) => item.source === source);
  const [text, setText] = useState('');
  const [field, setField] = useState<CatalogQuery['field']>('title');
  const [language, setLanguage] = useState<CatalogQuery['language']>('ru');
  const [page, setPage] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [composing, setComposing] = useState(false);
  const [results, setResults] = useState<CatalogPage<CatalogBook> | null>(null);
  const [phase, setPhase] = useState<
    'idle' | 'waiting' | 'loading' | 'ready' | 'error'
  >('idle');
  const [error, setError] = useState('');
  const [record, setRecord] = useState<CatalogBook | null>(null);
  const [editions, setEditions] = useState<CatalogPage<CatalogEdition> | null>(
    null,
  );
  const [editionPage, setEditionPage] = useState(0);
  const [edition, setEdition] = useState<CatalogEdition | null>(null);
  const [draft, setDraft] = useState<BookDraft>(blankDraft);
  const [targetId, setTargetId] = useState('new');
  const [replace, setReplace] = useState(false);
  const [remoteCover, setRemoteCover] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [duplicates, setDuplicates] = useState<Id[]>([]);
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const lock = useRef(false);
  const localCover = useBlobUrl(draft.cover);
  useEffect(() => {
    if (!text.trim() || composing || !provider) return;
    const abort = new AbortController();
    let active = true;
    const timer = setTimeout(() => {
      setPhase('loading');
      setError('');
      void provider.search({ text, field, language, page }, abort.signal).then(
        (response) => {
          if (active) {
            setResults(response);
            setPhase('ready');
          }
        },
        (reason: unknown) => {
          if (active && !abort.signal.aborted) {
            setError(
              reason instanceof Error ? reason.message : 'Поиск недоступен.',
            );
            setPhase('error');
          }
        },
      );
    }, 600);
    return () => {
      active = false;
      clearTimeout(timer);
      abort.abort();
    };
  }, [text, field, language, page, provider, attempt, composing]);
  useEffect(
    () => () => {
      operation.current?.abort();
      sequence.current++;
    },
    [],
  );
  const resetSearch = (nextText = text) => {
    setPage(0);
    setResults(null);
    setPhase(nextText.trim() ? 'waiting' : 'idle');
    setError('');
  };
  const request = async (action: (signal: AbortSignal) => Promise<void>) => {
    operation.current?.abort();
    const abort = new AbortController();
    operation.current = abort;
    const token = ++sequence.current;
    setBusy(true);
    setError('');
    try {
      await action(abort.signal);
    } catch (reason) {
      if (!abort.signal.aborted && token === sequence.current)
        setError(
          reason instanceof Error ? reason.message : 'Каталог недоступен.',
        );
    } finally {
      if (!abort.signal.aborted && token === sequence.current) setBusy(false);
    }
  };
  const showEditions = (book: CatalogBook, nextPage: number) =>
    request(async (signal) => {
      if (!provider) return;
      setRecord(book);
      setEdition(null);
      setEditions(null);
      setEditionPage(nextPage);
      const next = await provider.editions(book, nextPage, signal);
      signal.throwIfAborted();
      setRecord(next.record ?? book);
      setEditions(next);
    });
  const selectEdition = (candidate: CatalogEdition) =>
    request(async (signal) => {
      if (!provider || !record) return;
      const full = await provider.edition(record, candidate, signal);
      signal.throwIfAborted();
      setEdition(full);
      setTargetId('new');
      setReplace(false);
      setDuplicates([]);
      setAllowDuplicate(false);
      setDraft({
        title: full.title,
        authors: full.authors.join('; '),
        description: full.source === 'google-books' ? '' : full.description,
        genres: '',
        isbn: full.isbn.join('; '),
        cover: null,
        publisher: full.publisher,
        publishedDate: full.year,
      });
      setRemoteCover(
        full.source === 'open-library' ? (full.covers[0] ?? null) : null,
      );
    });
  const back = () => {
    operation.current?.abort();
    sequence.current++;
    setBusy(false);
    setError('');
    if (edition) setEdition(null);
    else {
      setRecord(null);
      setEditions(null);
    }
  };
  const target = books.find((book) => book.id === targetId) ?? null;
  const suggestions = edition
    ? books.filter((book) => catalogMatches(book, edition))
    : [];
  const patch = (value: Partial<BookDraft>) => {
    setDraft((current) => ({ ...current, ...value }));
  };
  const save = async () => {
    if (lock.current || !edition || !record) return;
    lock.current = true;
    setSaving(true);
    setBusy(true);
    setError('');
    const abort = new AbortController();
    operation.current?.abort();
    operation.current = abort;
    try {
      let cover = draft.cover;
      if (remoteCover && (!target || replace))
        cover = await copyCatalogCover(remoteCover, abort.signal);
      abort.signal.throwIfAborted();
      const saved = await saveCatalogSelection(store, {
        record,
        edition,
        draft: { ...draft, cover },
        target,
        replaceMetadata: replace,
        allowDuplicate,
        selectedCover: remoteCover,
      });
      await onSaved(saved.id);
    } catch (reason) {
      if (!abort.signal.aborted) {
        if (reason instanceof DuplicateBookError) setDuplicates(reason.bookIds);
        setError(
          reason instanceof Error
            ? reason.message
            : 'Не удалось добавить книгу.',
        );
      }
    } finally {
      lock.current = false;
      if (!abort.signal.aborted) {
        setSaving(false);
        setBusy(false);
      }
    }
  };
  const google = source === 'google-books';
  return (
    <Dialog
      open
      title="Поиск книг в каталогах"
      presentation="panel"
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <div className="form-stack catalog-search">
        {google && (
          <a href="https://books.google.com" target="_blank" rel="noreferrer">
            <img
              className="google-attribution"
              src="https://books.google.com/googlebooks/images/poweredby.png"
              alt="Powered by Google"
            />
          </a>
        )}
        {!record && (
          <>
            <p className="caption">
              Запрос отправляется выбранному каталогу. Ваши EPUB, заметки и
              история чтения не отправляются.
            </p>
            <form
              className="form-stack"
              onSubmit={(event) => {
                event.preventDefault();
                setAttempt((value) => value + 1);
              }}
            >
              <SelectField
                label="Источник каталога"
                value={source}
                onChange={(event) => {
                  resetSearch();
                  setSource(event.target.value);
                }}
              >
                <option value="open-library">Open Library</option>
                <option value="google-books">Google Books</option>
              </SelectField>
              <div className="catalog-filter-row">
                <SelectField
                  label="Искать по"
                  value={field}
                  onChange={(event) => {
                    resetSearch();
                    setField(event.target.value as CatalogQuery['field']);
                  }}
                >
                  <option value="title">Названию</option>
                  <option value="author">Автору</option>
                  <option value="isbn">ISBN</option>
                </SelectField>
                <SelectField
                  label="Язык поиска"
                  value={language}
                  onChange={(event) => {
                    resetSearch();
                    setLanguage(event.target.value as CatalogQuery['language']);
                  }}
                >
                  <option value="ru">Русский</option>
                  <option value="en">English</option>
                </SelectField>
              </div>
              <TextField
                label="Запрос в каталог"
                type="search"
                value={text}
                maxLength={200}
                onChange={(event) => {
                  resetSearch(event.target.value);
                  setText(event.target.value);
                }}
                onCompositionStart={() => {
                  setComposing(true);
                }}
                onCompositionEnd={() => {
                  setComposing(false);
                }}
              />
              <Button type="submit" disabled={text.trim().length < 2}>
                {google ? 'Search Books' : 'Найти в Open Library'}
              </Button>
            </form>
            {phase === 'loading' || phase === 'waiting' ? (
              <p role="status">Ищем книги…</p>
            ) : (
              phase === 'idle' && (
                <p className="caption">
                  Введите название, автора или ISBN. Для добавления своей книги
                  без интернета используйте ручное добавление.
                </p>
              )
            )}
            {results?.cached && (
              <p className="caption">Результаты из временного кэша.</p>
            )}
            {results && (
              <>
                <h3>
                  {google
                    ? 'Google Books search results'
                    : 'Результаты Open Library'}
                </h3>
                {!results.items.length && (
                  <p>
                    Ничего не найдено. Попробуйте другой язык, автора или ISBN.
                  </p>
                )}
                <ul className="catalog-results">
                  {results.items.map((book) => (
                    <li key={book.id}>
                      <Cover
                        key={book.covers[0]}
                        url={
                          book.covers[0] ? coverUrl(book.covers[0]) : undefined
                        }
                        title={book.title}
                      />
                      <div className="form-stack">
                        <h3>{book.title}</h3>
                        <p>{book.authors.join(', ') || 'Автор не указан'}</p>
                        <p className="caption">
                          {book.year || 'Год не указан'} ·{' '}
                          {book.publisher ||
                            (book.kind === 'work'
                              ? 'Выберите издание'
                              : 'Издательство не указано')}
                        </p>
                        <p className="catalog-description">
                          {book.description ||
                            'Описание уточняется после выбора издания.'}
                        </p>
                        <Source book={book} />
                        <Button
                          variant="secondary"
                          onClick={() => {
                            void showEditions(book, 0);
                          }}
                        >
                          Выбрать издание «{book.title}»
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="action-row">
                  <Button
                    variant="quiet"
                    disabled={page === 0}
                    onClick={() => {
                      setResults(null);
                      setPage((value) => value - 1);
                    }}
                  >
                    Предыдущие результаты
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={!results.more}
                    onClick={() => {
                      setResults(null);
                      setPage((value) => value + 1);
                    }}
                  >
                    Следующие результаты
                  </Button>
                </div>
              </>
            )}
          </>
        )}
        {record && (
          <>
            <Button variant="quiet" disabled={saving} onClick={back}>
              {edition ? 'К списку изданий' : 'К результатам поиска'}
            </Button>
            <Source book={record} />
          </>
        )}
        {record && !edition && (
          <>
            <h3>Издания «{record.title}»</h3>
            {busy && <p role="status">Загружаем издания…</p>}
            {editions && (
              <>
                <ul className="catalog-results">
                  {editions.items.map((item) => (
                    <li key={item.id}>
                      <Cover
                        key={item.covers[0]}
                        url={
                          item.covers[0] ? coverUrl(item.covers[0]) : undefined
                        }
                        title={item.title}
                      />
                      <div className="form-stack">
                        <h3>{item.title}</h3>
                        <p>{item.authors.join(', ')}</p>
                        <p className="caption">
                          {item.year || 'Год не указан'} ·{' '}
                          {item.publisher || 'Издательство не указано'} ·{' '}
                          {item.language || 'Язык не указан'}
                        </p>
                        <p>ISBN: {item.isbn.join(', ') || 'нет'}</p>
                        <p className="catalog-description">
                          {item.description ||
                            'Описание отсутствует в каталоге.'}
                        </p>
                        <Source book={item} />
                        <Button
                          disabled={busy}
                          onClick={() => {
                            void selectEdition(item);
                          }}
                        >
                          Выбрать {item.id}
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
                {!editions.items.length && (
                  <p>Издания не найдены. Попробуйте ISBN или другой каталог.</p>
                )}
                <div className="action-row">
                  <Button
                    variant="quiet"
                    disabled={busy || editionPage === 0}
                    onClick={() => {
                      void showEditions(record, editionPage - 1);
                    }}
                  >
                    Предыдущие издания
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={busy || !editions.more}
                    onClick={() => {
                      void showEditions(record, editionPage + 1);
                    }}
                  >
                    Следующие издания
                  </Button>
                </div>
              </>
            )}
          </>
        )}
        {edition && (
          <>
            <section className="form-stack">
              <h3>Данные выбранного издания</h3>
              <p>
                {edition.title} · {edition.authors.join(', ')}
              </p>
              <p>
                {edition.publisher} · {edition.year}
              </p>
              <p className="preserve-text">
                {edition.description || 'Описание отсутствует в каталоге.'}
              </p>
              {edition.descriptionSource === 'work' && (
                <p className="caption">
                  Описание произведения; отдельного описания издания нет.
                </p>
              )}
              <Source book={edition} />
            </section>
            {google && (
              <p className="caption">
                Описание и обложка Google Books показаны для справки и не
                сохраняются бессрочно. Введите своё описание и выберите
                локальную обложку.
              </p>
            )}
            <form
              className="form-stack"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <h3>Ваша запись в библиотеке</h3>
              <SelectField
                label="Добавить или сопоставить"
                value={targetId}
                disabled={busy}
                onChange={(event) => {
                  setTargetId(event.target.value);
                  setReplace(false);
                  setError('');
                }}
              >
                <option value="new">Создать новую книгу</option>
                {books.map((book) => (
                  <option key={book.id} value={book.id}>
                    {suggestions.some((item) => item.id === book.id)
                      ? 'Совпадение идентификатора: '
                      : 'Связать: '}
                    {book.title}
                  </option>
                ))}
              </SelectField>
              {target && (
                <>
                  <p className="caption">
                    Файлы, прочтения, отзывы, заметки и прогресс останутся у
                    существующей книги.
                  </p>
                  <label className="catalog-check">
                    <input
                      type="checkbox"
                      checked={replace}
                      disabled={busy}
                      onChange={(event) => {
                        setReplace(event.target.checked);
                      }}
                    />
                    Заменить метаданные книги значениями из формы ниже
                  </label>
                </>
              )}
              {(!target || replace) && (
                <fieldset disabled={busy} className="form-fieldset form-stack">
                  <TextField
                    label="Название книги"
                    value={draft.title}
                    required
                    maxLength={500}
                    onChange={(event) => {
                      patch({ title: event.target.value });
                    }}
                  />
                  <TextField
                    label="Авторы книги"
                    value={draft.authors}
                    hint="Несколько авторов — через точку с запятой."
                    onChange={(event) => {
                      patch({ authors: event.target.value });
                    }}
                  />
                  <TextField
                    label="Издательство издания"
                    value={draft.publisher ?? ''}
                    maxLength={500}
                    onChange={(event) => {
                      patch({ publisher: event.target.value });
                    }}
                  />
                  <TextField
                    label="Дата издания"
                    value={draft.publishedDate ?? ''}
                    maxLength={100}
                    onChange={(event) => {
                      patch({ publishedDate: event.target.value });
                    }}
                  />
                  <TextField
                    label="ISBN издания"
                    value={draft.isbn}
                    onChange={(event) => {
                      patch({ isbn: event.target.value });
                    }}
                  />
                  <TextArea
                    label="Ваше описание"
                    value={draft.description}
                    onChange={(event) => {
                      patch({ description: event.target.value });
                    }}
                  />
                  <TextField
                    label="Жанры книги"
                    value={draft.genres}
                    onChange={(event) => {
                      patch({ genres: event.target.value });
                    }}
                  />
                  <h4>Локальная обложка</h4>
                  <Cover
                    key={localCover ?? remoteCover}
                    url={
                      localCover ??
                      (remoteCover ? coverUrl(remoteCover) : undefined)
                    }
                    title={draft.title}
                  />
                  {!google && (
                    <SelectField
                      label="Альтернативная обложка каталога"
                      value={remoteCover ?? ''}
                      onChange={(event) => {
                        patch({ cover: null });
                        setRemoteCover(event.target.value || null);
                      }}
                    >
                      <option value="">Без каталожной обложки</option>
                      {edition.covers.map((url, i) => (
                        <option key={url} value={url}>
                          Обложка {i + 1}
                        </option>
                      ))}
                    </SelectField>
                  )}
                  <TextField
                    label="Выбрать свою обложку"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      void request(async (signal) => {
                        const blob = await copyCover(file);
                        signal.throwIfAborted();
                        patch({ cover: blob });
                        setRemoteCover(null);
                      });
                    }}
                  />
                  <Button
                    variant="quiet"
                    onClick={() => {
                      patch({ cover: null });
                      setRemoteCover(null);
                    }}
                  >
                    Сохранить без обложки
                  </Button>
                </fieldset>
              )}
              {duplicates.length > 0 && (
                <div className="form-stack">
                  <p>
                    Совпадает ISBN или идентификатор издания. Выберите
                    существующую книгу для сопоставления.
                  </p>
                  {duplicates.map((bookId) => (
                    <Button
                      key={bookId}
                      variant="secondary"
                      onClick={() => {
                        setTargetId(bookId);
                        setReplace(false);
                        setError('');
                      }}
                    >
                      Связать с «
                      {books.find((book) => book.id === bookId)?.title ??
                        bookId}
                      »
                    </Button>
                  ))}
                  <label className="catalog-check">
                    <input
                      type="checkbox"
                      checked={allowDuplicate}
                      onChange={(event) => {
                        setAllowDuplicate(event.target.checked);
                      }}
                    />
                    Я хочу отдельную запись этого издания
                  </label>
                </div>
              )}
              <Button type="submit" disabled={busy}>
                {busy
                  ? 'Сохраняем…'
                  : target
                    ? 'Сопоставить с существующей книгой'
                    : 'Добавить издание в библиотеку'}
              </Button>
            </form>
          </>
        )}
        {error && (
          <div role="alert">
            <p>{error}</p>
            {!record && (
              <Button
                variant="secondary"
                onClick={() => {
                  setAttempt((value) => value + 1);
                }}
              >
                Повторить поиск
              </Button>
            )}
            {record && !edition && (
              <Button
                variant="secondary"
                onClick={() => {
                  void showEditions(record, editionPage);
                }}
              >
                Повторить загрузку изданий
              </Button>
            )}
          </div>
        )}
        <Button variant="quiet" disabled={saving} onClick={onClose}>
          Закрыть поиск
        </Button>
      </div>
    </Dialog>
  );
}
