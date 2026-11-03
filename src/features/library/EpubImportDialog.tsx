import { useEffect, useRef, useState } from 'react';
import type { Book, BookFileSummary, Id } from '../../domain/model';
import type { EpubAdapter, EpubAnalysis } from '../../domain/epub';
import { EpubImportError } from '../../domain/epub';
import { DuplicateBookError } from '../../domain/library';
import type { LocalStore } from '../../domain/repositories';
import { prepareEpub, saveEpub } from '../../services/epub-import';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { SelectField } from '../../ui/FormControls';
import { TextField } from '../../ui/TextField';
import { useBlobUrl } from '../../ui/useBlobUrl';
import { formatCount } from '../../ui/format';

export function EpubImportDialog({
  adapter,
  format = 'epub',
  store,
  books,
  target,
  onClose,
  onSaved,
}: {
  adapter: EpubAdapter;
  format?: 'epub' | 'fb2';
  store: LocalStore;
  books: Book[];
  target: Id | null;
  onClose: () => void;
  onSaved: (id: Id) => Promise<void>;
}) {
  const label = format === 'fb2' ? 'FB2' : 'EPUB';
  const controller = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState<
    'choose' | 'working' | 'review' | 'saving' | 'duplicate' | 'cancelled'
  >('choose');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<EpubAnalysis | null>(null);
  const [existing, setExisting] = useState<BookFileSummary | null>(null);
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [bookId, setBookId] = useState<string>(target ?? 'new');
  const [duplicateWarning, setDuplicateWarning] = useState(false);
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const busy = phase === 'working' || phase === 'saving';
  const lock = useRef(false);
  const coverUrl = useBlobUrl(analysis?.cover ?? null);
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  const choose = async (file: File | undefined) => {
    if (!file || lock.current) return;
    if (!(format === 'fb2' ? /\.fb2$/i : /\.epub$/i).test(file.name)) {
      setError(`Выберите файл ${label}.`);
      return;
    }
    lock.current = true;
    controller.current?.abort();
    const task = new AbortController();
    controller.current = task;
    setName(file.name);
    setPhase('working');
    setError(null);
    setAnalysis(null);
    setExisting(null);
    setDuplicateWarning(false);
    setAllowDuplicate(false);
    try {
      const result = await prepareEpub(
        adapter,
        store,
        file,
        task.signal,
        setProgress,
      );
      setAnalysis(result.analysis);
      setTitle(result.analysis.metadata.title);
      if (result.existing) {
        setExisting(result.existing);
        setPhase('duplicate');
      } else setPhase('review');
    } catch (reason) {
      if (reason instanceof EpubImportError && reason.code === 'cancelled')
        setPhase('cancelled');
      else {
        setError(
          reason instanceof Error
            ? reason.message
            : 'Не удалось импортировать EPUB.',
        );
        setPhase('choose');
      }
    } finally {
      lock.current = false;
    }
  };
  const save = async () => {
    if (!analysis || lock.current || !controller.current) return;
    const selected = books.find((book) => book.id === bookId);
    if (bookId !== 'new' && !selected) {
      setError('Выберите существующую книгу или создайте новую.');
      return;
    }
    lock.current = true;
    setPhase('saving');
    setError(null);
    setProgress('Сохраняем оригинал и текстовый индекс на устройстве…');
    try {
      const result = await saveEpub(
        store,
        analysis,
        {
          name,
          targetBookId: selected?.id ?? null,
          title,
          allowDuplicateBook: allowDuplicate,
        },
        controller.current.signal,
      );
      if (result.duplicate) {
        const file = await store.findEpubByHash(analysis.sha256);
        setExisting(file ?? null);
        setPhase('duplicate');
      } else await onSaved(result.bookId);
    } catch (reason) {
      if (reason instanceof EpubImportError && reason.code === 'cancelled')
        setPhase('cancelled');
      else {
        if (reason instanceof DuplicateBookError) setDuplicateWarning(true);
        setError(
          reason instanceof Error
            ? reason.message
            : 'Не удалось сохранить EPUB.',
        );
        setPhase('review');
      }
    } finally {
      lock.current = false;
    }
  };
  const cancel = () => {
    if (busy) {
      controller.current?.abort();
      setProgress('Отменяем импорт…');
    } else onClose();
  };
  return (
    <Dialog open title={`Импорт ${label}`} onClose={cancel}>
      <div className="form-stack">
        <p className="caption">
          Файл обрабатывается и хранится только на этом устройстве. На сервер он
          не отправляется.
        </p>
        {!busy && (
          <div className="field">
            <label htmlFor="epub-file">Файл {label}</label>
            <input
              id="epub-file"
              type="file"
              accept={
                format === 'fb2'
                  ? '.fb2,application/x-fictionbook+xml,text/xml,application/xml'
                  : '.epub,application/epub+zip'
              }
              onChange={(event) => {
                void choose(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            <p className="caption">
              {format === 'fb2'
                ? 'До 16 МБ. Оригинал FB2 хранится локально; для чтения создаётся локальный EPUB.'
                : 'До 32 МБ. EPUB 2 и EPUB 3 без DRM и активных скриптов.'}
            </p>
          </div>
        )}
        {name && <p className="caption import-hash">Выбран файл: {name}</p>}
        {busy && (
          <p role="status" aria-live="polite">
            {progress}
          </p>
        )}
        {phase === 'cancelled' && (
          <p role="status">Импорт отменён. Ничего не сохранено.</p>
        )}
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        {phase === 'duplicate' && (
          <div className="form-stack">
            <h3>Этот файл уже в библиотеке</h3>
            <p>
              SHA-256 совпадает. Новые книги, файлы и прочтения не созданы;
              существующие записи не изменены.
            </p>
            {existing && (
              <Button
                onClick={() => {
                  void onSaved(existing.bookId);
                }}
              >
                Открыть книгу с этим {label}
              </Button>
            )}
          </div>
        )}
        {analysis && phase === 'review' && (
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {coverUrl && (
              <img
                className="cover-preview"
                src={coverUrl}
                alt={`Встроенная обложка ${label}`}
              />
            )}
            <p>
              <strong>{analysis.metadata.title}</strong>
              <br />
              {analysis.metadata.authors.join(', ') || 'Автор не указан'}
            </p>
            <p className="caption">
              Язык: {analysis.metadata.language || 'не указан'} · {label}{' '}
              {format === 'epub' ? analysis.version : ''}
            </p>
            <p className="caption">
              {formatCount(analysis.sections.length, [
                'линейный ресурс',
                'линейных ресурса',
                'линейных ресурсов',
              ])}{' '}
              ·{' '}
              {formatCount(
                analysis.sections.reduce(
                  (sum, section) => sum + section.wordCount,
                  0,
                ),
                ['слово', 'слова', 'слов'],
              )}
              . Порядок проверен по spine; оглавление содержит{' '}
              {formatCount(analysis.navigation.length, [
                'раздел верхнего уровня',
                'раздела верхнего уровня',
                'разделов верхнего уровня',
              ])}
              .
            </p>
            {analysis.warnings.map((warning) => (
              <p className="caption" key={warning}>
                {warning}
              </p>
            ))}
            <details>
              <summary>SHA-256 оригинала</summary>
              <p className="import-hash">{analysis.sha256}</p>
            </details>
            <SelectField
              label="Куда импортировать"
              value={bookId}
              onChange={(event) => {
                setBookId(event.target.value);
                setError(null);
              }}
            >
              <option value="new">Создать новую книгу</option>
              {books.map((book) => (
                <option key={book.id} value={book.id}>
                  Прикрепить: {book.title}
                </option>
              ))}
            </SelectField>
            {bookId === 'new' ? (
              <TextField
                label="Название новой книги"
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                }}
                required
                maxLength={500}
              />
            ) : (
              <p className="caption">
                Метаданные, отзывы, прочтения и старые файлы этой книги
                останутся без изменений. Позиции не переносятся автоматически на
                новый файл.
              </p>
            )}
            {duplicateWarning && bookId === 'new' && (
              <label className="import-checkbox">
                <input
                  type="checkbox"
                  checked={allowDuplicate}
                  onChange={(event) => {
                    setAllowDuplicate(event.target.checked);
                  }}
                />
                <span>
                  Я хочу создать отдельную книгу с похожими метаданными
                </span>
              </label>
            )}
            <Button type="submit">
              {bookId === 'new'
                ? `Создать книгу и сохранить ${label}`
                : `Прикрепить ${label}`}
            </Button>
          </form>
        )}
        <Button variant="secondary" onClick={cancel}>
          {busy ? 'Отменить импорт' : 'Закрыть импорт'}
        </Button>
      </div>
    </Dialog>
  );
}
