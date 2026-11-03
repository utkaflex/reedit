import { useSpeedReading } from '../speed-reading/useSpeedReading';
import { RsvpWord, SpeedControls } from '../speed-reading/SpeedReadingUI';
import { ReaderAnnotations } from '../annotations/ReaderAnnotations';
import type { ReaderSelection } from '../../domain/reader';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EpubAdapter } from '../../domain/epub';
import type { EpubIndex } from '../../domain/model';
import type { LocalStore } from '../../domain/repositories';
import {
  defaultReaderPreferences,
  type ReaderLocation,
  type ReaderPreferences,
  type ReaderSession,
} from '../../domain/reader';
import {
  createPositionWriter,
  loadReader,
  saveReaderPreferences,
  type ReaderAddress,
} from '../../services/reader';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import { ReaderSettings } from './ReaderSettings';
import { ReaderContents } from './ReaderContents';
import './reader.css';
import { useReadingActivity } from './useReadingActivity';

export function ReaderScreen({
  store,
  adapter,
  address,
}: {
  store: LocalStore;
  adapter: EpubAdapter;
  address: ReaderAddress;
}) {
  const host = useRef<HTMLDivElement>(null);
  const session = useRef<ReaderSession | null>(null);
  const writer = useRef<ReturnType<typeof createPositionWriter> | null>(null);
  const [readerInstance, setReaderInstance] = useState<ReaderSession | null>(
    null,
  );
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [fatal, setFatal] = useState('');
  const [preparation, setPreparation] = useState('Подготавливаем книгу…');
  const preparationStage = useRef('Подготавливаем книгу…');
  const [notice, setNotice] = useState<string | null>(null);
  const [title, setTitle] = useState('Чтение');
  const [index, setIndex] = useState<EpubIndex | null>(null);
  const [location, setLocation] = useState<ReaderLocation | null>(null);
  const [preferences, setPreferences] = useState({
    ...defaultReaderPreferences,
  });
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState<'saving' | 'saved' | 'error'>('saved');
  const [controls, setControls] = useState(true);
  const [panel, setPanel] = useState<'settings' | 'contents' | null>(null);
  const [retry, setRetry] = useState(0);
  const [fromStart, setFromStart] = useState(false);
  const [selection, setSelection] = useState<ReaderSelection | null>(null);
  const [notesPanel, setNotesPanel] = useState<'saved' | 'bookmark' | null>(
    null,
  );
  const [leave, setLeave] = useState(false);
  const [speedChooser, setSpeedChooser] = useState(false);
  const speedActive = useRef(false);
  const activity = useReadingActivity(store, address);
  const {
    attach: attachActivity,
    observe: observeActivity,
    interact: activityInteraction,
  } = activity;
  const speedPosition = useCallback(async (next: ReaderLocation) => {
    setLocation(next);
    writer.current?.push(next);
    await writer.current?.flush();
  }, []);
  const speedChanged = useCallback((active: boolean) => {
    speedActive.current = active;
  }, []);
  const speed = useSpeedReading(
    state === 'ready' ? readerInstance : null,
    store,
    speedPosition,
    speedChanged,
    activity.speedState,
    activity.completed,
  );
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    const root = document.documentElement;
    const previousRoot = root.style.backgroundColor;
    const previousBody = document.body.style.backgroundColor;
    const color =
      preferences.theme === 'dark'
        ? '#191b19'
        : preferences.theme === 'sepia'
          ? '#f1e5cd'
          : '#fffefa';
    let firstFrame = 0,
      secondFrame = 0;
    const apply = () => {
      meta?.setAttribute('content', color);
      root.style.backgroundColor = color;
      document.body.style.backgroundColor = color;
    };
    const repaint = () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      apply();
      firstFrame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(apply);
      });
    };
    repaint();
    window.addEventListener('reedit:dialog-closed', repaint);
    window.addEventListener('pageshow', repaint);
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      window.removeEventListener('reedit:dialog-closed', repaint);
      window.removeEventListener('pageshow', repaint);
      root.style.backgroundColor = previousRoot;
      document.body.style.backgroundColor = previousBody;
      meta?.setAttribute(
        'content',
        getComputedStyle(document.documentElement)
          .getPropertyValue('--color-bg')
          .trim(),
      );
    };
  }, [preferences.theme]);
  useEffect(() => {
    const abort = new AbortController();
    let completed = false;
    const openingTimer = setTimeout(() => {
      if (completed || abort.signal.aborted) return;
      setFatal(
        `Открытие книги заняло слишком много времени. Не удалось завершить: «${preparationStage.current}». Попробуйте ещё раз или откройте другое издание. Файл и сохранённое место остались в библиотеке.`,
      );
      setState('error');
      abort.abort();
    }, 60000);
    const isCancelled = () => abort.signal.aborted;
    let current: ReaderSession | null = null;
    const positions = createPositionWriter(store, address, (next, message) => {
      if (!abort.signal.aborted) {
        setSaving(next);
        if (message) setNotice(message);
      }
    });
    writer.current = positions;
    const start = async () => {
      try {
        const data = await loadReader(store, address);
        if (isCancelled() || !host.current) return;
        setTitle(data.book.title);
        setIndex(data.index);
        setPreferences(data.preferences);
        document.title = `${data.book.title} — Reedit`;
        current = await adapter.openReader({
          host: host.current,
          file: data.file,
          index: data.index,
          preferences: data.preferences,
          cfi: fromStart ? null : (data.position?.cfi ?? null),
          ...(!fromStart && data.position?.cursor
            ? { cursor: data.position.cursor }
            : {}),
          ...(data.documentIndex ? { documentIndex: data.documentIndex } : {}),
          onDocumentIndex: async (index) => {
            abort.signal.throwIfAborted();
            preparationStage.current = 'Сохраняем подготовленный текст…';
            setPreparation(preparationStage.current);
            return await store.cacheDocumentTextIndex(index);
          },
          signal: abort.signal,
          onProgress: (message) => {
            if (!abort.signal.aborted) {
              preparationStage.current = message;
              setPreparation(message);
            }
          },
          onInteraction: activityInteraction,
          onSelection: (value) => {
            if (!abort.signal.aborted) setSelection(value);
          },
          onLocation: (next) => {
            if (!abort.signal.aborted) {
              setLocation(next);
              observeActivity(next);
              if (!speedActive.current) positions.push(next);
            }
          },
          onToggleControls: () => {
            if (!abort.signal.aborted && !speedActive.current)
              setControls((value) => !value);
          },
          onBusy: (value) => {
            if (!abort.signal.aborted) setBusy(value);
          },
          onError: (message) => {
            if (!abort.signal.aborted) setNotice(message);
          },
        });
        if (isCancelled()) {
          current.destroy();
          return;
        }
        session.current = current;
        setReaderInstance(current);
        setState('ready');
        completed = true;
        clearTimeout(openingTimer);
        const documentIndex = current.getTextIndex?.();
        if (documentIndex) {
          try {
            await attachActivity(documentIndex, abort.signal);
          } catch {
            if (!isCancelled())
              setNotice(
                'Книга открыта, но учёт времени пока недоступен. Продолжайте чтение; сохранение позиции работает отдельно.',
              );
          }
          if (isCancelled()) {
            current.destroy();
            return;
          }
        }
        if (address.savedId && address.savedKind) {
          const item = await store.repositories[address.savedKind].get(
            address.savedId,
          );
          if (
            item?.anchor &&
            item.bookId === address.bookId &&
            item.bookFileId === address.fileId &&
            item.readingId === address.readingId
          ) {
            try {
              await current.goToSaved(
                item.anchor,
                'quote' in item ? item.quote : undefined,
              );
            } catch (reason) {
              setNotice(
                reason instanceof Error
                  ? reason.message
                  : 'Переход к заметке недоступен.',
              );
            }
          } else
            setNotice('Сохранённый фрагмент или исходный файл недоступен.');
        }
      } catch (error) {
        completed = true;
        clearTimeout(openingTimer);
        if (!abort.signal.aborted) {
          setFatal(
            error instanceof Error
              ? error.message
              : 'Не удалось открыть книгу.',
          );
          setState('error');
        }
      }
    };
    const flush = () => {
      void positions.flush().catch(() => undefined);
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flush);
    void start();
    return () => {
      clearTimeout(openingTimer);
      abort.abort();
      current?.destroy();
      session.current = null;
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flush);
      void positions.flush().catch(() => undefined);
    };
  }, [
    store,
    adapter,
    address,
    retry,
    fromStart,
    attachActivity,
    observeActivity,
    activityInteraction,
  ]);
  const command = (action: (reader: ReaderSession) => Promise<boolean>) => {
    const reader = session.current;
    if (!reader) return;
    void action(reader).catch((error: unknown) => {
      setNotice(
        error instanceof Error
          ? error.message
          : 'Не удалось перейти к странице.',
      );
    });
  };
  const close = async () => {
    try {
      await writer.current?.flush();
      await activity.flush();
      window.location.hash = '#/library';
    } catch {
      setLeave(true);
    }
  };
  const apply = async (next: ReaderPreferences) => {
    const applied = await session.current?.setPreferences(next);
    if (!applied) throw new Error('Дождитесь завершения перехода и повторите.');
    setPreferences(next);
    try {
      await saveReaderPreferences(store, next);
    } catch (error) {
      setNotice(
        'Оформление изменено, но не сохранено на устройстве. Повторите применение настроек.',
      );
      throw error;
    }
  };
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="reader-screen"
      data-reader-theme={preferences.theme}
      data-speed-active={speed.snapshot.active}
      data-motion={preferences.animations ? 'on' : 'off'}
      aria-label="Читалка"
      onKeyDown={(event) => {
        if (
          panel ||
          notesPanel ||
          speed.snapshot.active ||
          speedChooser ||
          event.target instanceof HTMLTextAreaElement ||
          event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLSelectElement ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        )
          return;
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault();
          command((reader) =>
            event.key === 'ArrowRight' ? reader.next() : reader.previous(),
          );
        }
      }}
    >
      <header
        className={`reader-top ${controls ? '' : 'reader-chrome-hidden'}`}
      >
        <Button
          variant="quiet"
          className="icon-button"
          aria-label="Закрыть книгу"
          onClick={() => {
            void close();
          }}
        >
          <Icon name="back" />
        </Button>
        <h1 title={title}>{title}</h1>
        <Button
          variant="quiet"
          aria-label="Цитаты и закладки"
          disabled={state !== 'ready' || busy}
          onClick={() => {
            setNotesPanel('saved');
          }}
        >
          <Icon name="quote" />
        </Button>
        <Button
          variant="quiet"
          aria-label="Добавить закладку"
          disabled={state !== 'ready' || busy}
          onClick={() => {
            setNotesPanel('bookmark');
          }}
        >
          <Icon name="bookmark" />
        </Button>
        <Button
          variant="quiet"
          disabled={state !== 'ready' || busy}
          aria-label="Оглавление"
          onClick={() => {
            setPanel('contents');
          }}
        >
          <Icon name="contents" />
        </Button>
        <Button
          variant="quiet"
          disabled={state !== 'ready' || busy}
          aria-label="Оформление чтения"
          onClick={() => {
            setPanel('settings');
          }}
        >
          Aa
        </Button>
      </header>
      <section className="reader-stage" aria-label="Область чтения">
        <div ref={host} className="reader-host" data-testid="reader-host" />
        {speed.snapshot.active && speed.snapshot.mode === 'rsvp' && (
          <RsvpWord
            snapshot={speed.snapshot}
            pause={() => {
              speed.service?.pause();
            }}
          />
        )}
        {state === 'loading' && (
          <div className="reader-message" role="status">
            {preparation}
          </div>
        )}
        {state === 'error' && (
          <div className="reader-message form-stack">
            <h2>Не удалось открыть EPUB</h2>
            <p role="alert">{fatal}</p>
            <details>
              <summary>Сведения об ошибке</summary>
              <p className="caption">
                Сборка {__REEDIT_BUILD__.slice(0, 8)} · {preparation}
              </p>
            </details>
            <Button
              variant="secondary"
              onClick={() => {
                setState('loading');
                setRetry((value) => value + 1);
              }}
            >
              Повторить открытие
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                setState('loading');
                setFromStart(true);
                setRetry((value) => value + 1);
              }}
            >
              Открыть с начала
            </Button>
            <a className="button button--secondary" href="#/library">
              К библиотеке
            </a>
          </div>
        )}
      </section>
      <footer className="reader-bottom">
        {activity.error && (
          <div role="alert" className="form-error">
            {activity.error}{' '}
            <Button
              variant="quiet"
              onClick={() => {
                void activity.flush().catch(() => undefined);
              }}
            >
              Повторить запись статистики
            </Button>
          </div>
        )}
        {speed.snapshot.active ? (
          <SpeedControls
            snapshot={speed.snapshot}
            run={speed.run}
            service={speed.service}
          />
        ) : (
          <>
            <div
              inert={Boolean(selection)}
              className={`reader-footer-content ${controls && !notice ? '' : 'reader-chrome-hidden'}`}
            >
              <div className="reader-progress-row">
                <span className="reader-chapter" title={location?.chapter}>
                  {location?.chapter ?? 'Подготовка'}
                </span>
                <Button
                  variant="quiet"
                  disabled={state !== 'ready' || busy}
                  onClick={() => {
                    setSpeedChooser(true);
                  }}
                >
                  Скорочтение
                </Button>
                <span
                  aria-label="Позиция в читаемом тексте"
                  title="Прогресс до якоря видимого фрагмента, по текстовому объёму"
                >
                  {Math.round((location?.progression ?? 0) * 100)}%
                </span>
              </div>
              <progress
                aria-label="Прогресс по читаемому тексту"
                max="1"
                value={location?.progression ?? 0}
              />
              <Button
                variant="quiet"
                className="reader-confirm"
                aria-label="Фрагмент прочитан"
                disabled={!activity.canConfirm || busy}
                onClick={activity.confirm}
                title="Я прочитал видимый фрагмент. Перелистывания сами по себе не учитывают прочитанные слова."
              >
                <Icon name="check" />
                <span>Прочитано</span>
              </Button>
              <div className="reader-navigation">
                <Button
                  variant="quiet"
                  aria-label={
                    preferences.mode === 'scroll'
                      ? 'Предыдущий раздел'
                      : 'Предыдущая страница'
                  }
                  disabled={state !== 'ready' || busy || location?.atStart}
                  onClick={() => {
                    command((reader) => reader.previous());
                  }}
                >
                  <Icon name="back" />
                </Button>
                <span className="reader-save-state" role="status">
                  {state === 'loading'
                    ? 'Открываем книгу…'
                    : state === 'error'
                      ? 'Чтение недоступно'
                      : busy
                        ? 'Обновляем страницу…'
                        : saving === 'saving'
                          ? 'Сохраняем позицию…'
                          : saving === 'error'
                            ? 'Позиция не сохранена'
                            : 'Позиция сохранена'}
                </span>
                <Button
                  variant="quiet"
                  aria-label={
                    preferences.mode === 'scroll'
                      ? 'Следующий раздел'
                      : 'Следующая страница'
                  }
                  disabled={state !== 'ready' || busy || location?.atEnd}
                  onClick={() => {
                    command((reader) => reader.next());
                  }}
                >
                  <Icon name="arrow" />
                </Button>
              </div>
            </div>
            {!controls && !notice && (
              <Button
                className="reader-show-controls"
                variant="quiet"
                onClick={() => {
                  setControls(true);
                }}
              >
                Показать панели
              </Button>
            )}
            {notice && (
              <div
                className="reader-notice"
                role="region"
                aria-label="Сообщение читалки"
              >
                <p role="alert">{notice}</p>
                {saving === 'error' && (
                  <Button
                    variant="quiet"
                    onClick={() => {
                      void writer.current?.flush().then(
                        () => {
                          setNotice(null);
                        },
                        () => undefined,
                      );
                    }}
                  >
                    Повторить сохранение
                  </Button>
                )}
                <Button
                  variant="quiet"
                  aria-label="Скрыть сообщение"
                  onClick={() => {
                    setNotice(null);
                  }}
                >
                  <Icon name="close" />
                </Button>
              </div>
            )}
            <ReaderAnnotations
              store={store}
              address={address}
              reader={state === 'ready' ? readerInstance : null}
              selection={selection}
              panel={notesPanel}
              onClose={() => {
                setNotesPanel(null);
              }}
              onClear={() => {
                setSelection(null);
              }}
            />
          </>
        )}
      </footer>
      {speedChooser && (
        <Dialog
          open
          title="Режимы чтения"
          onClose={() => {
            setSpeedChooser(false);
          }}
        >
          <div className="form-stack">
            <p>
              Начнём с выбранного слова или якоря видимого фрагмента.
              Воспроизведение запускается кнопкой «Продолжить».
            </p>
            <Button
              onClick={() => {
                setSpeedChooser(false);
                setSelection(null);
                speed.run((session) => session.open('rsvp'));
              }}
            >
              RSVP — по одному слову
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setSpeedChooser(false);
                setSelection(null);
                speed.run((session) => session.open('guided'));
              }}
            >
              Guided Reading — в тексте
            </Button>
          </div>
        </Dialog>
      )}
      {panel === 'settings' && (
        <ReaderSettings
          preferences={preferences}
          navigationBusy={busy}
          onClose={() => {
            setPanel(null);
          }}
          onApply={apply}
        />
      )}
      {panel === 'contents' && index && (
        <ReaderContents
          index={index}
          onClose={() => {
            setPanel(null);
          }}
          onNavigate={(target) => {
            setPanel(null);
            command((reader) => reader.goTo(target));
          }}
        />
      )}
      {leave && (
        <Dialog
          open
          title="Выйти без сохранения?"
          onClose={() => {
            setLeave(false);
          }}
        >
          <p>
            Последнюю позицию или статистику не удалось записать. Ранее
            сохранённые данные останутся на устройстве; последние несохранённые
            изменения могут быть потеряны.
          </p>
          <Button
            variant="secondary"
            onClick={() => {
              setLeave(false);
            }}
          >
            Продолжить чтение
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              window.location.hash = '#/library';
            }}
          >
            Выйти без сохранения
          </Button>
        </Dialog>
      )}
    </main>
  );
}
