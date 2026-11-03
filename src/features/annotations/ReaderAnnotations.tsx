import { useCallback, useEffect, useRef, useState } from 'react';
import { newId, type HighlightColor } from '../../domain/model';
import type { ReaderSelection, ReaderSession } from '../../domain/reader';
import type { LocalStore } from '../../domain/repositories';
import type { ReaderAddress } from '../../services/reader';
import { saveSelection } from '../../services/annotations';
import { readerUrl } from '../shell/navigation';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { TextField } from '../../ui/TextField';
import { TextArea } from '../../ui/FormControls';
import { ColorField, SavedNotes } from './SavedNotes';

export function ReaderAnnotations({
  store,
  address,
  reader,
  selection,
  panel,
  onClose,
  onClear,
}: {
  store: LocalStore;
  address: ReaderAddress;
  reader: ReaderSession | null;
  selection: ReaderSelection | null;
  panel: 'saved' | 'bookmark' | null;
  onClose: () => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState<ReaderSelection | null>(null);
  const [note, setNote] = useState('');
  const [color, setColor] = useState<HighlightColor>('yellow');
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const bookmark = useRef<ReaderSelection | null>(null);
  const refresh = useCallback(async () => {
    const items = await store.repositories.annotations.list();
    reader?.setHighlights(
      items.filter((item) => item.bookId === address.bookId),
    );
  }, [store, reader, address.bookId]);
  useEffect(() => {
    let active = true;
    const load = () => {
      void store.repositories.annotations.list().then(
        (items) => {
          if (active)
            reader?.setHighlights(
              items.filter((item) => item.bookId === address.bookId),
            );
        },
        (reason: unknown) => {
          if (active)
            setError(
              reason instanceof Error
                ? reason.message
                : 'Выделения недоступны.',
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
  }, [store, reader, address.bookId]);
  useEffect(() => {
    if (panel === 'bookmark') {
      bookmark.current = reader?.getBookmark() ?? null;
    }
  }, [panel, reader]);
  const perform = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Не удалось выполнить действие.',
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const save = (value: ReaderSelection, comment: string) =>
    perform(async () => {
      await saveSelection(store, address, value, color, comment);
      await refresh();
      setDraft(null);
      onClear();
      setMessage('Фрагмент сохранён');
    });
  return (
    <>
      {selection && !draft && !panel && (
        <div
          className="selection-actions"
          role="group"
          aria-label="Действия с выделенным текстом"
          onPointerDown={(event) => {
            event.preventDefault();
          }}
        >
          <Button
            variant="quiet"
            disabled={busy}
            onClick={() => {
              void save(selection, '');
            }}
          >
            Выделить
          </Button>
          <Button
            variant="quiet"
            disabled={busy}
            onClick={() => {
              setDraft(selection);
              setNote('');
              setError('');
            }}
          >
            Заметка
          </Button>
          {typeof navigator.clipboard !== 'undefined' &&
            typeof navigator.clipboard.writeText === 'function' && (
              <Button
                variant="quiet"
                onClick={() => {
                  void perform(async () => {
                    await navigator.clipboard.writeText(selection.quote);
                    setMessage('Цитата скопирована');
                  });
                }}
              >
                Копировать
              </Button>
            )}
          {typeof navigator.share === 'function' && (
            <Button
              variant="quiet"
              onClick={() => {
                // Invoke native share synchronously from the user gesture, before any database work.
                const shared = navigator.share({ text: selection.quote });
                void shared.catch((reason: unknown) => {
                  if (!(
                    reason instanceof DOMException &&
                    reason.name === 'AbortError'
                  ))
                    setError('Не удалось поделиться цитатой.');
                });
              }}
            >
              Поделиться
            </Button>
          )}
          <Button variant="quiet" onClick={onClear}>
            Закрыть меню
          </Button>
          {error && <span role="alert">{error}</span>}
          {message && <span role="status">{message}</span>}
        </div>
      )}
      {!selection && !panel && error && (
        <div className="annotation-error">
          <p role="alert">{error}</p>
          <Button
            variant="quiet"
            onClick={() => {
              setError('');
            }}
          >
            Скрыть ошибку
          </Button>
        </div>
      )}
      {draft && (
        <Dialog
          open
          title="Заметка к цитате"
          onClose={() => {
            if (!busy) setDraft(null);
          }}
        >
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              void save(draft, note);
            }}
          >
            <blockquote>{draft.quote}</blockquote>
            <TextArea
              label="Комментарий"
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
            <ColorField value={color} onChange={setColor} />
            {error && <p role="alert">{error}</p>}
            <Button type="submit" disabled={busy}>
              Сохранить заметку
            </Button>
          </form>
        </Dialog>
      )}
      {panel === 'bookmark' && (
        <Dialog
          open
          title="Добавить закладку"
          onClose={() => {
            if (!busy) onClose();
          }}
        >
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                const value = bookmark.current;
                if (!value)
                  throw new Error('Дождитесь загрузки позиции и повторите.');
                const now = Date.now();
                await store.repositories.bookmarks.save(
                  {
                    id: newId(),
                    createdAt: now,
                    updatedAt: now,
                    bookId: address.bookId,
                    bookFileId: address.fileId,
                    readingId: address.readingId,
                    cfi: value.cfi,
                    anchor: value.anchor,
                    label: label.trim() || 'Закладка',
                  },
                  { expectedUpdatedAt: null },
                );
                setLabel('');
                onClose();
              });
            }}
          >
            <TextField
              label="Название закладки"
              value={label}
              onChange={(event) => {
                setLabel(event.target.value);
              }}
              maxLength={200}
              hint="Закладка сохранит якорь видимого фрагмента."
            />
            {error && <p role="alert">{error}</p>}
            <Button type="submit" disabled={busy}>
              Сохранить закладку
            </Button>
          </form>
        </Dialog>
      )}
      {panel === 'saved' && (
        <Dialog open title="Цитаты и закладки книги" onClose={onClose}>
          <SavedNotes
            store={store}
            initialBook={address.bookId}
            onChanged={() => {
              void refresh().catch(() => {
                setError('Не удалось обновить выделения.');
              });
            }}
            onNavigate={(item) => {
              if (!item.anchor) return;
              onClose();
              if (
                item.bookId &&
                item.bookFileId &&
                item.bookFileId !== address.fileId
              ) {
                window.location.assign(
                  readerUrl({
                    bookId: item.bookId,
                    fileId: item.bookFileId,
                    readingId: item.readingId,
                    savedId: item.id,
                    savedKind: 'quote' in item ? 'annotations' : 'bookmarks',
                  }),
                );
                return;
              }
              void reader
                ?.goToSaved(
                  item.anchor,
                  'quote' in item ? item.quote : undefined,
                )
                .catch((reason: unknown) => {
                  setError(
                    reason instanceof Error
                      ? reason.message
                      : 'Переход недоступен.',
                  );
                });
            }}
          />
        </Dialog>
      )}
    </>
  );
}
