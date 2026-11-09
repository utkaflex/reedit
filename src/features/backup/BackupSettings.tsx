import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { EpubAdapter } from '../../domain/epub';
import type { LocalStore } from '../../domain/repositories';
import type { BackupStatus, PreparedBackup } from '../../domain/backup';
import { exportLibrary, inspectBackup } from '../../services/backup';
import {
  activateUpdate,
  checkPwaUpdate,
  pwaSnapshot,
  requestPersistence,
  storageCapacity,
  subscribePwa,
  type StorageCapacity,
} from '../../services/pwa';
import { DisclosureRow } from '../../ui/DisclosureRow';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';

const mb = (value: number) => `${(value / 1024 / 1024).toFixed(1)} МБ`;
export function BackupSettings({
  store,
  adapter,
}: {
  store: LocalStore;
  adapter: EpubAdapter;
}) {
  const pwa = useSyncExternalStore(subscribePwa, pwaSnapshot);
  const [capacity, setCapacity] = useState<StorageCapacity | null>(null);
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [now] = useState(() => Date.now());
  const [includeFiles, setIncludeFiles] = useState(true);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [download, setDownload] = useState<{
    url: string;
    at: number;
    includesFiles: boolean;
  } | null>(null);
  const [preview, setPreview] = useState<{
    backup: PreparedBackup;
    revision: string;
    currentBooks: number;
  } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void storageCapacity().then((value) => {
      if (alive.current) setCapacity(value);
    });
    void store
      .backupStatus()
      .then((value) => {
        if (alive.current) setStatus(value);
      })
      .catch((reason: unknown) => {
        if (alive.current)
          setError(
            reason instanceof Error
              ? reason.message
              : 'Не удалось проверить дату копии.',
          );
      });
    return () => {
      alive.current = false;
      abort.current?.abort();
    };
  }, [store]);
  useEffect(
    () => () => {
      if (download) URL.revokeObjectURL(download.url);
    },
    [download],
  );
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [busy]);
  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError(null);
    setMessage('Подготавливаем…');
    try {
      await action(controller.signal);
    } catch (reason) {
      if (alive.current) {
        setError(
          controller.signal.aborted
            ? 'Операция отменена. Библиотека не изменена.'
            : reason instanceof Error
              ? reason.message
              : 'Не удалось выполнить операцию.',
        );
        setMessage('');
      }
    } finally {
      lock.current = false;
      if (alive.current) {
        setBusy(false);
        void storageCapacity().then(setCapacity);
      }
    }
  };
  const progress = (value: string) => {
    if (alive.current) setMessage(value);
  };
  const stale =
    status &&
    (status.lastBackupAt === null || now - status.lastBackupAt > 30 * 86400000);
  return (
    <section
      className="settings-group backup-settings"
      aria-labelledby="backup-title"
    >
      <h2 id="backup-title">Данные и приложение</h2>
      <h3 className="settings-group-label">Хранение и копии</h3>
      <div className="form-stack">
        <DisclosureRow
          title="Данные на устройстве"
          icon="device"
          detail={
            capacity?.quota &&
            capacity.usage !== null &&
            capacity.usage / capacity.quota > 0.85
              ? 'Мало свободного места'
              : capacity?.usage !== null && capacity?.usage !== undefined
                ? `Занято ${mb(capacity.usage)}`
                : 'Книги и записи сохранены локально'
          }
        >
          <section className="surface form-stack backup-card">
            <p>
              {capacity?.usage !== null && capacity?.usage !== undefined
                ? `Занято примерно ${mb(capacity.usage)}`
                : 'Браузер не сообщил занятое место.'}
              {capacity?.quota
                ? ` из доступных сайту ${mb(capacity.quota)}.`
                : ''}
            </p>
            {capacity?.quota &&
            capacity.usage !== null &&
            capacity.usage / capacity.quota > 0.85 ? (
              <p role="alert">
                Свободного места мало. Сохраните резервную копию; новые записи
                могут не поместиться.
              </p>
            ) : null}
            <p className="caption">
              Оценка приблизительная.{' '}
              {capacity?.persistent
                ? 'Браузер разрешил устойчивое хранение.'
                : 'Данные могут быть вытеснены браузером.'}{' '}
              Даже разрешение устойчивого хранения не защищает от очистки сайта,
              удаления приложения или потери устройства.
            </p>
            <Button
              variant="secondary"
              disabled={busy || pwa.updating}
              onClick={() => {
                void run(async () => {
                  const persisted = await requestPersistence();
                  setCapacity(await storageCapacity());
                  setMessage(
                    persisted === null
                      ? 'Браузер не поддерживает запрос устойчивого хранения.'
                      : persisted
                        ? 'Устойчивое хранение разрешено. Резервные копии всё равно нужны.'
                        : 'Браузер не предоставил устойчивое хранение. Можно пользоваться приложением и сохранять резервные копии.',
                  );
                });
              }}
            >
              Запросить устойчивое хранение
            </Button>
          </section>
        </DisclosureRow>
        <DisclosureRow
          title="Резервная копия"
          icon="upload"
          detail={
            stale ? 'Сохраните копию вне приложения' : 'Создать и скачать ZIP'
          }
        >
          <section className="surface form-stack backup-card">
            {stale && (
              <p role="status" className="availability-note">
                {status.lastBackupAt === null
                  ? 'Вы ещё не подтвердили сохранение резервной копии.'
                  : 'С последней подтверждённой копии прошло больше 30 дней.'}{' '}
                Сохраните свежий архив вне браузера.
              </p>
            )}
            {status?.lastBackupAt !== null &&
              status?.lastBackupAt !== undefined && (
                <p className="caption">
                  Последняя подтверждённая копия:{' '}
                  {new Date(status.lastBackupAt).toLocaleString('ru')}
                  {status.includedFiles
                    ? ', с файлами книг.'
                    : ', без файлов книг.'}
                </p>
              )}
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={includeFiles}
                disabled={busy}
                onChange={(e) => {
                  setIncludeFiles(e.target.checked);
                  setDownload(null);
                }}
              />{' '}
              Включить файлы книг (EPUB и FB2)
            </label>
            <p className="caption">
              Обложки, отзывы, цитаты, позиции, дневник, статистика и настройки
              включаются всегда. Без файлов книги остаются в библиотеке, но для
              чтения потребуется повторное прикрепление оригиналов. Лимит архива
              — 128 МБ.
            </p>
            <Button
              disabled={busy || pwa.updating}
              onClick={() => {
                void run(async (signal) => {
                  const blob = await exportLibrary(
                    store,
                    includeFiles,
                    signal,
                    progress,
                  );
                  signal.throwIfAborted();
                  if (!alive.current) return;
                  setDownload({
                    url: URL.createObjectURL(blob),
                    at: Date.now(),
                    includesFiles: includeFiles,
                  });
                  setMessage(
                    'Архив подготовлен локально. Скачайте его и проверьте сохранение в «Файлы».',
                  );
                });
              }}
            >
              Создать ZIP резервной копии
            </Button>
            {download && !busy && (
              <div className="form-stack">
                <a
                  className="button button--secondary"
                  href={download.url}
                  download={`reedit-${new Date(download.at).toISOString().slice(0, 10)}.zip`}
                >
                  Скачать архив ZIP
                </a>
                <Button
                  variant="quiet"
                  disabled={busy}
                  onClick={() => {
                    void run(async () => {
                      await store.confirmBackup(
                        download.at,
                        download.includesFiles,
                      );
                      setStatus(await store.backupStatus());
                      setMessage(
                        'Дата сохранения подтверждена. Храните архив вне браузера.',
                      );
                    });
                  }}
                >
                  Архив сохранён — подтвердить
                </Button>
              </div>
            )}
          </section>
        </DisclosureRow>
        <DisclosureRow
          title="Восстановить из копии"
          icon="repeat"
          detail={'Сначала проверим архив'}
        >
          <section className="surface form-stack backup-card">
            <p className="caption">
              Архив сначала проверяется без изменения базы. Восстановление
              заменяет действующую библиотеку. Перед этим создайте её отдельную
              копию и закройте книги в других вкладках.
            </p>
            <label className="field">
              ZIP резервной копии
              <input
                className="field__input"
                type="file"
                accept=".zip,application/zip"
                disabled={busy || pwa.updating}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  setPreview(null);
                  setConfirmed(false);
                  void run(async (signal) => {
                    const backup = await inspectBackup(
                      file,
                      adapter,
                      signal,
                      progress,
                    );
                    const current = await store.readBackup();
                    signal.throwIfAborted();
                    if (!alive.current) return;
                    setPreview({
                      backup,
                      revision: current.revision,
                      currentBooks: current.tables.books.length,
                    });
                    setMessage('Архив проверен. Библиотека пока не изменена.');
                  });
                }}
              />
            </label>
          </section>
        </DisclosureRow>
        <h3 className="settings-group-label">На этом устройстве</h3>
        <DisclosureRow
          title="Работа офлайн"
          icon="device"
          detail={
            pwa.phase === 'update'
              ? 'Доступно обновление'
              : pwa.phase === 'ready'
                ? 'Готово к чтению без сети'
                : pwa.phase === 'error'
                  ? 'Не удалось подготовить офлайн'
                  : pwa.phase === 'development'
                    ? 'Доступно в установленной версии'
                    : 'Проверить готовность'
          }
        >
          <section className="surface form-stack backup-card">
            <p role="status">
              {pwa.phase === 'development'
                ? 'Режим разработки: Service Worker включён только в production-сборке.'
                : pwa.phase === 'preparing'
                  ? 'Готовим все разделы для работы без интернета…'
                  : pwa.message}
            </p>
            {pwa.phase === 'update' && (
              <Button
                disabled={busy || pwa.updating}
                onClick={() => {
                  void activateUpdate();
                }}
              >
                Обновить приложение
              </Button>
            )}
            {(pwa.phase === 'ready' || pwa.phase === 'update') && (
              <Button
                variant="quiet"
                disabled={busy || pwa.updating}
                onClick={() => {
                  void checkPwaUpdate();
                }}
              >
                Проверить обновления
              </Button>
            )}
            {pwa.phase === 'error' && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  window.location.reload();
                }}
              >
                Повторить подготовку офлайн
              </Button>
            )}
          </section>
        </DisclosureRow>
        <DisclosureRow
          title="Установка"
          icon="plus"
          detail="На экран «Домой» на iPhone"
        >
          <p>
            Откройте Reedit в Safari по HTTPS. В меню «Поделиться» выберите «На
            экран “Домой”», затем «Добавить». Если есть переключатель «Открывать
            как веб-приложение», оставьте его включённым. Откройте установленное
            приложение с интернетом и дождитесь готовности офлайн-режима.
          </p>
          <p className="caption">
            Книги и записи локальны для этого приложения и устройства. Перед
            переносом или очисткой сайта сохраните ZIP в «Файлы» либо на другое
            устройство.
          </p>
        </DisclosureRow>
        <p className="settings-local-warning">
          Данные только на этом устройстве. Очистка сайта может удалить их —
          сохраняйте копию вне приложения.
        </p>
        {busy && (
          <Button
            variant="quiet"
            onClick={() => {
              abort.current?.abort();
            }}
          >
            Отменить операцию
          </Button>
        )}
        {message && (
          <p role="status" aria-live="polite">
            {message}
          </p>
        )}
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
      </div>
      {preview && (
        <Dialog
          open
          title="Заменить библиотеку из копии?"
          onClose={() => {
            if (!busy) setPreview(null);
          }}
        >
          <div className="form-stack">
            <p>
              Дата копии:{' '}
              {new Date(preview.backup.manifest.createdAt).toLocaleString('ru')}
              . Книг: {preview.backup.tables.books.length}; файлов:{' '}
              {preview.backup.tables.bookFiles.length}; цитат:{' '}
              {preview.backup.tables.annotations.length}; записей дневника:{' '}
              {preview.backup.tables.journal.length}.
            </p>
            <p>
              Действующая библиотека ({preview.currentBooks} книг) будет
              полностью заменена.{' '}
              {preview.backup.manifest.includesFiles
                ? 'Копия включает файлы книг.'
                : 'В копии нет файлов книг. Текущие файлы тоже будут убраны; для чтения понадобятся оригиналы.'}
            </p>
            <p>
              Ошибка или отмена до завершения транзакции оставит действующую
              библиотеку на месте. После успеха приложение перезагрузится.
            </p>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy}
                onChange={(e) => {
                  setConfirmed(e.target.checked);
                }}
              />{' '}
              Я понимаю замену библиотеки и сохранил нужные текущие данные
            </label>
            {error && (
              <p role="alert" className="error-text">
                {error}
              </p>
            )}
            <Button
              variant="danger"
              disabled={!confirmed || busy}
              onClick={() => {
                void run(async (signal) => {
                  await store.restoreBackup(
                    preview.backup,
                    preview.revision,
                    { confirmed },
                    signal,
                  );
                  window.location.hash = '#/library';
                  window.location.reload();
                });
              }}
            >
              Заменить библиотеку
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setPreview(null);
              }}
            >
              Отмена
            </Button>
            {busy && (
              <Button
                variant="quiet"
                onClick={() => {
                  abort.current?.abort();
                }}
              >
                Отменить восстановление
              </Button>
            )}
          </div>
        </Dialog>
      )}
      {pwa.updating && (
        <Dialog open title="Обновляем Reedit" onClose={() => undefined}>
          <p role="status">{pwa.message}</p>
        </Dialog>
      )}
    </section>
  );
}
