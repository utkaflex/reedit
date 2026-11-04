import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Annotation,
  Bookmark,
  Book,
  BookFileSummary,
  HighlightColor,
} from '../../domain/model';
import type { LocalStore } from '../../domain/repositories';
import { contentIdentity, highlightColors } from '../../domain/annotations';
import {
  downloadAnnotations,
  exportAnnotations,
} from '../../services/annotations';
import { readerUrl } from '../shell/navigation';
import { EmptyState } from '../../ui/EmptyState';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { SelectField, TextArea } from '../../ui/FormControls';
import { TextField } from '../../ui/TextField';
import './annotations.css';

type Saved = Annotation | Bookmark;
export function ColorField({
  value,
  onChange,
}: {
  value: HighlightColor;
  onChange: (color: HighlightColor) => void;
}) {
  return (
    <fieldset className="highlight-colors">
      <legend>Цвет выделения</legend>
      {Object.entries(highlightColors).map(([key, item]) => (
        <label
          key={key}
          style={{ '--highlight-fill': item.fill } as React.CSSProperties}
        >
          <input
            type="radio"
            name="highlight-color"
            value={key}
            checked={value === key}
            onChange={() => {
              onChange(key as HighlightColor);
            }}
          />
          {item.label}
        </label>
      ))}
    </fieldset>
  );
}
export function SavedNotes({
  store,
  initialBook = '',
  onNavigate,
  onChanged,
}: {
  store: LocalStore;
  initialBook?: string;
  onNavigate?: (item: Saved) => void;
  onChanged?: () => void;
}) {
  const [data, setData] = useState<{
    books: Book[];
    files: BookFileSummary[];
    notes: Annotation[];
    bookmarks: Bookmark[];
  } | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [book, setBook] = useState(initialBook);
  const [color, setColor] = useState('');
  const [after, setAfter] = useState('');
  const [before, setBefore] = useState('');
  const [kind, setKind] = useState('quotes');
  const [editing, setEditing] = useState<Saved | null>(null);
  const [comment, setComment] = useState('');
  const [editColor, setEditColor] = useState<HighlightColor>('yellow');
  const [removing, setRemoving] = useState<Saved | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const reload = useCallback(async () => {
    const [books, files, notes, bookmarks] = await Promise.all([
      store.repositories.books.list(),
      store.listBookFiles(),
      store.repositories.annotations.list(),
      store.repositories.bookmarks.list(),
    ]);
    return { books, files, notes, bookmarks };
  }, [store]);
  useEffect(() => {
    let active = true;
    const load = () => {
      void reload().then(
        (next) => {
          if (active) {
            setData(next);
            setError('');
          }
        },
        (reason: unknown) => {
          if (active)
            setError(
              reason instanceof Error
                ? reason.message
                : 'Не удалось загрузить заметки.',
            );
        },
      );
    };
    load();
    window.addEventListener('focus', load);
    return () => {
      active = false;
      window.removeEventListener('focus', load);
    };
  }, [reload]);
  const perform = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
      setData(await reload());
      onChanged?.();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Не удалось сохранить.',
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const items: Saved[] = data
    ? kind === 'bookmarks'
      ? data.bookmarks
      : data.notes
    : [];
  const filtered = items
    .filter((item) => {
      const text = 'quote' in item ? `${item.quote} ${item.note}` : item.label;
      const title = data?.books.find((b) => b.id === item.bookId)?.title ?? '';
      return (
        (!book || item.bookId === book) &&
        (!color || ('quote' in item && (item.color ?? 'yellow') === color)) &&
        (!after || item.createdAt >= new Date(`${after}T00:00:00`).getTime()) &&
        (!before ||
          item.createdAt < new Date(`${before}T23:59:59.999`).getTime() + 1) &&
        `${text} ${title}`
          .toLocaleLowerCase('ru')
          .includes(query.trim().toLocaleLowerCase('ru'))
      );
    })
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  const navigate = (item: Saved) => {
    if (onNavigate) {
      onNavigate(item);
      return;
    }
    if (item.bookId && item.bookFileId)
      window.location.assign(
        readerUrl({
          bookId: item.bookId,
          fileId: item.bookFileId,
          readingId: item.readingId,
          savedId: item.id,
          savedKind: 'quote' in item ? 'annotations' : 'bookmarks',
        }),
      );
  };
  return (
    <section
      className="saved-notes form-stack"
      aria-label="Сохранённые фрагменты"
    >
      {data && (data.notes.length > 0 || data.bookmarks.length > 0) && (
        <div className="notes-toolbar">
          <TextField
            label="Поиск цитат и заметок"
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
          />
          <SelectField
            label="Показывать"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setColor('');
            }}
          >
            <option value="quotes">Цитаты и заметки</option>
            <option value="bookmarks">Закладки</option>
          </SelectField>
          <details className="notes-filter-disclosure">
            <summary>
              Фильтры{book || color || after || before ? ' · применены' : ''}
            </summary>
            <div className="notes-filters">
              {' '}
              <SelectField
                label="Книга"
                value={book}
                onChange={(e) => {
                  setBook(e.target.value);
                }}
              >
                <option value="">Все книги</option>
                {data.books.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title}
                  </option>
                ))}
              </SelectField>
              {kind === 'quotes' && (
                <SelectField
                  label="Цвет"
                  value={color}
                  onChange={(e) => {
                    setColor(e.target.value);
                  }}
                >
                  <option value="">Все цвета</option>
                  {Object.entries(highlightColors).map(([key, item]) => (
                    <option key={key} value={key}>
                      {item.label}
                    </option>
                  ))}
                </SelectField>
              )}
              <TextField
                label="Созданы с"
                type="date"
                value={after}
                onChange={(e) => {
                  setAfter(e.target.value);
                }}
              />
              <TextField
                label="Созданы по"
                type="date"
                value={before}
                onChange={(e) => {
                  setBefore(e.target.value);
                }}
              />
            </div>
          </details>
          {(query || book || color || after || before) && (
            <div className="active-filters">
              <span>
                {[
                  query,
                  data.books.find((b) => b.id === book)?.title,
                  color ? highlightColors[color as HighlightColor].label : '',
                  after,
                  before,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              <Button
                variant="quiet"
                onClick={() => {
                  setQuery('');
                  setBook('');
                  setColor('');
                  setAfter('');
                  setBefore('');
                }}
              >
                Сбросить фильтры
              </Button>
            </div>
          )}
        </div>
      )}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <Button
            variant="secondary"
            onClick={() => {
              void perform(async () => {});
            }}
          >
            Обновить список
          </Button>
        </div>
      )}
      {!data && !error && <p role="status">Загружаем заметки…</p>}
      {data && filtered.length === 0 && (
        <EmptyState
          icon="quote"
          title={
            items.length
              ? 'Нет подходящих фрагментов'
              : 'Слова, к которым хочется вернуться'
          }
        >
          <p>
            {items.length
              ? 'Измените условия поиска или сбросьте фильтры.'
              : 'Выделите текст в книге, чтобы сохранить цитату. Добавьте к ней свою мысль — она останется рядом.'}
          </p>
          <a className="button button--secondary" href="#/library">
            К библиотеке
          </a>
        </EmptyState>
      )}
      {kind === 'quotes' && filtered.length > 0 && (
        <div className="notes-actions">
          {(['markdown', 'text'] as const).map((format) => (
            <Button
              key={format}
              variant="secondary"
              onClick={() => {
                if (data)
                  downloadAnnotations(
                    exportAnnotations(
                      filtered.filter(
                        (item): item is Annotation => 'quote' in item,
                      ),
                      data.books,
                      format,
                    ),
                    format,
                  );
              }}
            >
              Экспорт {format === 'markdown' ? 'Markdown' : 'TXT'}
            </Button>
          ))}
        </div>
      )}
      <ul className="notes-list">
        {filtered.map((item) => {
          const source = data?.books.find((book) => book.id === item.bookId);
          const file = data?.files.find(
            (file) =>
              file.id === item.bookFileId &&
              file.bookId === item.bookId &&
              contentIdentity(file) === item.anchor?.contentId,
          );
          return (
            <li
              key={item.id}
              className="saved-fragment"
              style={
                {
                  '--highlight-fill':
                    'quote' in item
                      ? highlightColors[item.color ?? 'yellow'].fill
                      : 'var(--color-border)',
                } as React.CSSProperties
              }
            >
              <p className="caption">
                {data?.books.find((b) => b.id === item.bookId)?.title ??
                  'Книга'}{' '}
                ·{' '}
                <time dateTime={new Date(item.createdAt).toISOString()}>
                  {new Date(item.createdAt).toLocaleDateString('ru')}
                </time>
              </p>
              {source && source.authors.length > 0 && (
                <p className="caption">{source.authors.join(', ')}</p>
              )}
              {'quote' in item ? (
                <>
                  <blockquote>{item.quote}</blockquote>
                  {item.note && <p className="saved-comment">{item.note}</p>}
                </>
              ) : (
                <h3>{item.label || 'Закладка'}</h3>
              )}
              <div className="notes-actions">
                <Button
                  variant="quiet"
                  disabled={!file || !item.anchor}
                  onClick={() => {
                    navigate(item);
                  }}
                >
                  К месту в книге
                </Button>
                <Button
                  variant="quiet"
                  disabled={busy}
                  onClick={() => {
                    setEditing(item);
                    setComment('quote' in item ? item.note : item.label);
                    setEditColor(
                      'quote' in item ? (item.color ?? 'yellow') : 'yellow',
                    );
                  }}
                >
                  Редактировать
                </Button>
                <Button
                  variant="quiet"
                  disabled={busy}
                  onClick={() => {
                    setRemoving(item);
                  }}
                >
                  Удалить
                </Button>
              </div>
              {(!file || !item.anchor) && (
                <p className="caption">
                  {item.anchor
                    ? 'Исходный файл отсутствует. Прикрепите тот же файл к этой книге для перехода.'
                    : 'У старой записи нет проверенной текстовой привязки. Переход недоступен.'}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {editing && (
        <Dialog
          open
          title={
            'quote' in editing ? 'Редактировать заметку' : 'Название закладки'
          }
          onClose={() => {
            if (!busy) setEditing(null);
          }}
        >
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              const item = editing;
              void perform(async () => {
                const next = {
                  ...item,
                  updatedAt: Math.max(Date.now(), item.updatedAt + 1),
                };
                if ('quote' in next)
                  await store.repositories.annotations.save(
                    { ...next, note: comment.trim(), color: editColor },
                    { expectedUpdatedAt: item.updatedAt },
                  );
                else
                  await store.repositories.bookmarks.save(
                    { ...next, label: comment.trim() },
                    { expectedUpdatedAt: item.updatedAt },
                  );
                setEditing(null);
              });
            }}
          >
            {'quote' in editing ? (
              <>
                <blockquote>{editing.quote}</blockquote>
                <TextArea
                  label="Комментарий"
                  value={comment}
                  onChange={(e) => {
                    setComment(e.target.value);
                  }}
                />
                <ColorField value={editColor} onChange={setEditColor} />
              </>
            ) : (
              <TextField
                label="Название закладки"
                value={comment}
                onChange={(e) => {
                  setComment(e.target.value);
                }}
                maxLength={200}
              />
            )}
            {error && <p role="alert">{error}</p>}
            <Button type="submit" disabled={busy}>
              Сохранить изменения
            </Button>
          </form>
        </Dialog>
      )}
      {removing && (
        <Dialog
          open
          title="Удалить сохранённый фрагмент?"
          onClose={() => {
            if (!busy) setRemoving(null);
          }}
        >
          <p>Цитата или закладка будет удалена с устройства.</p>
          {error && <p role="alert">{error}</p>}
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              const item = removing;
              void perform(async () => {
                await store.removeSaved(
                  'quote' in item ? 'annotations' : 'bookmarks',
                  item.id,
                  item.updatedAt,
                );
                setRemoving(null);
              });
            }}
          >
            Удалить фрагмент
          </Button>
        </Dialog>
      )}
    </section>
  );
}
