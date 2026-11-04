import type { CatalogProvider } from '../../domain/catalog';

import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { LocalStore } from '../../domain/repositories';
import {
  loadAppearance,
  saveAppearance,
  type Theme,
} from '../../services/appearance';
import {
  checkStorage,
  type StorageStatus,
} from '../../services/storage-status';
import { AppShell } from '../../ui/AppShell';
import { Button } from '../../ui/Button';
import { Dialog, Panel } from '../../ui/Dialog';
import { EmptyState } from '../../ui/EmptyState';
import { Icon } from '../../ui/Icon';
import { List, ListItem } from '../../ui/List';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { StatusCard } from '../../ui/StatusCard';
import { parseRoute, parseReaderAddress, type Route } from './navigation';

import type { EpubAdapter } from '../../domain/epub';
const ReaderScreen = lazy(async () => ({
  default: (await import('../reader/ReaderScreen')).ReaderScreen,
}));
const Library = lazy(async () => ({
  default: (await import('../library/Library')).Library,
}));
const SavedNotes = lazy(async () => ({
  default: (await import('../annotations/SavedNotes')).SavedNotes,
}));
const BackupSettings = lazy(async () => {
  const module = await import('../backup/BackupSettings');
  return { default: module.BackupSettings };
});
const StatisticsPage = lazy(async () => {
  const module = await import('../statistics/StatisticsPage');
  return { default: module.StatisticsPage };
});
class SectionBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <div role="alert" className="form-stack">
          <p>
            Не удалось открыть раздел. Локальные данные сохранены. Проверьте
            подключение, если раздел открывается впервые.
          </p>
          <Button
            onClick={() => {
              window.location.reload();
            }}
          >
            Повторить загрузку раздела
          </Button>
        </div>
      );
    return this.props.children;
  }
}

const titles: Record<Route, string> = {
  library: 'Библиотека',
  quotes: 'Мои цитаты',
  statistics: 'Статистика',
  settings: 'Настройки',
  reading: 'Чтение',
  'not-found': 'Страница не найдена',
};
const themes: readonly { value: Theme; label: string }[] = [
  { value: 'system', label: 'Авто' },
  { value: 'light', label: 'Светлая' },
  { value: 'dark', label: 'Тёмная' },
];

export function App({
  store,
  epubAdapter,
  catalogProviders,
}: {
  store: LocalStore;
  epubAdapter: EpubAdapter;
  catalogProviders: CatalogProvider[];
}) {
  const [hash, setHash] = useState(window.location.hash);
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  const [readerAddress, setReaderAddress] = useState(() =>
    parseReaderAddress(window.location.hash),
  );
  const [status, setStatus] = useState<StorageStatus>({ state: 'checking' });
  const [attempt, setAttempt] = useState(0);
  const [theme, setTheme] = useState<Theme>('system');
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<'storage' | 'about' | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const previousRoute = useRef(route);

  useEffect(() => {
    const navigate = () => {
      setHash(window.location.hash);
      setRoute(parseRoute(window.location.hash));
      setReaderAddress(parseReaderAddress(window.location.hash));
      setOverlay(null);
    };
    window.addEventListener('hashchange', navigate);
    return () => {
      window.removeEventListener('hashchange', navigate);
    };
  }, []);
  useEffect(() => {
    document.title = `${titles[route]} — Reedit`;
    if (previousRoute.current !== route) {
      heading.current?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: 'instant' });
      previousRoute.current = route;
    }
  }, [route]);
  useEffect(() => {
    let cancelled = false;
    const isCancelled = () => cancelled;
    const load = async () => {
      const result = await checkStorage(store);
      if (isCancelled()) return;
      if (result.state !== 'ready') {
        setStatus(result);
        return;
      }
      try {
        const settings = await loadAppearance(store.repositories.settings);
        if (!isCancelled()) {
          setTheme(settings?.theme ?? 'system');
          setStatus(result);
        }
      } catch {
        if (!isCancelled())
          setStatus({
            state: 'error',
            message: 'Не удалось загрузить настройки. Повторите проверку.',
          });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [store, attempt]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const updateChrome = () => {
      if (window.location.hash.startsWith('#/reading/')) return;
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute(
          'content',
          getComputedStyle(document.documentElement)
            .getPropertyValue('--color-bg')
            .trim(),
        );
    };
    updateChrome();
    query.addEventListener('change', updateChrome);
    return () => {
      query.removeEventListener('change', updateChrome);
    };
  }, [theme]);
  const changeTheme = async (value: Theme) => {
    if (saveInFlight.current || status.state !== 'ready') return;
    saveInFlight.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await saveAppearance(store.repositories.settings, value);
      setTheme(saved.theme);
    } catch (error) {
      setSaveError(
        `${error instanceof Error ? error.message : 'Не удалось сохранить оформление.'} Оформление не изменено. Попробуйте ещё раз.`,
      );
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };
  const retry = () => {
    setStatus({ state: 'checking' });
    setAttempt((value) => value + 1);
  };

  if (route === 'reading' && readerAddress)
    return (
      <AppShell route="reading">
        <SectionBoundary>
          <Suspense fallback={<p role="status">Открываем книгу…</p>}>
            <ReaderScreen
              key={`${readerAddress.fileId}-${readerAddress.readingId}`}
              store={store}
              adapter={epubAdapter}
              address={readerAddress}
            />
          </Suspense>
        </SectionBoundary>
      </AppShell>
    );
  return (
    <AppShell route={route}>
      <main id="main-content" tabIndex={-1} className={`page page--${route}`}>
        {route === 'reading' && (
          <a className="back-link" href="#/library">
            <Icon name="back" />К библиотеке
          </a>
        )}
        <header className="page-header" key={route}>
          <p className="eyebrow">
            {route === 'library'
              ? 'На вашей полке'
              : route === 'statistics'
                ? 'В своём ритме'
                : route === 'settings'
                  ? 'Так, как вам удобно'
                  : 'Reedit'}
          </p>
          <h1 ref={heading} tabIndex={-1}>
            {route === 'library' && (
              <span className="desktop-title-prefix">Моя </span>
            )}
            {titles[route]}
          </h1>
          <p className="page-subtitle">
            {route === 'library'
              ? 'Хорошим книгам нужно своё место.'
              : route === 'statistics'
                ? 'У каждого читателя своя история.'
                : route === 'settings'
                  ? 'Немного деталей. Больше вашего.'
                  : null}
          </p>
        </header>
        {route === 'quotes' && status.state === 'ready' && (
          <SectionBoundary key={hash}>
            <Suspense fallback={<p role="status">Загружаем цитаты…</p>}>
              <SavedNotes
                key={hash}
                store={store}
                initialBook={
                  new URLSearchParams(hash.split('?')[1]).get('book') ?? ''
                }
              />
            </Suspense>
          </SectionBoundary>
        )}
        {route === 'library' && status.state === 'ready' && (
          <SectionBoundary>
            <Suspense fallback={<p role="status">Открываем библиотеку…</p>}>
              <Library
                store={store}
                epubAdapter={epubAdapter}
                catalogProviders={catalogProviders}
              />
            </Suspense>
          </SectionBoundary>
        )}
        {route === 'statistics' && status.state === 'ready' && (
          <SectionBoundary>
            <Suspense fallback={<p role="status">Открываем историю чтения…</p>}>
              <StatisticsPage store={store} />
            </Suspense>
          </SectionBoundary>
        )}
        {route === 'settings' && (
          <div className="settings-stack">
            <section
              className="settings-group"
              aria-labelledby="appearance-title"
            >
              <div className="section-heading">
                <h2 id="appearance-title">Тема</h2>
                <Icon name="settings" />
              </div>
              <div className="surface appearance-settings" aria-busy={saving}>
                <SegmentedControl
                  label="Тема приложения"
                  value={theme}
                  options={themes}
                  onChange={(value) => {
                    void changeTheme(value);
                  }}
                  disabled={status.state !== 'ready'}
                />

                <p className="save-status" role="status" aria-live="polite">
                  {saving ? 'Сохраняем оформление…' : ''}
                </p>
                {saveError && (
                  <p className="error-text" role="alert">
                    {saveError}
                  </p>
                )}
              </div>
            </section>
            {status.state !== 'ready' && (
              <StatusCard status={status} onRetry={retry} />
            )}
            {status.state === 'ready' && (
              <SectionBoundary>
                <Suspense
                  fallback={<p role="status">Загружаем управление копиями…</p>}
                >
                  <BackupSettings store={store} adapter={epubAdapter} />
                </Suspense>
              </SectionBoundary>
            )}
            <section className="settings-group" aria-labelledby="about-title">
              <details className="settings-about">
                <summary id="about-title">О приложении</summary>
                <List label="Информация о Reedit">
                  <ListItem
                    title="О хранении данных"
                    description="Что остаётся на этом устройстве"
                    onClick={() => {
                      setOverlay('storage');
                    }}
                  />
                  <ListItem
                    title="О Reedit"
                    description="Личное пространство для чтения"
                    onClick={() => {
                      setOverlay('about');
                    }}
                  />
                </List>
                <p className="caption">
                  Reedit v2 · Сборка {__REEDIT_BUILD__.slice(0, 8)}
                </p>
              </details>
            </section>
          </div>
        )}
        {route === 'reading' && (
          <EmptyState icon="book" title="Выберите книгу для чтения">
            <p>
              Откройте карточку книги в библиотеке и выберите прикреплённый EPUB
              и прочтение.
            </p>
          </EmptyState>
        )}
        {route === 'not-found' && (
          <EmptyState icon="info" title="Такого раздела пока нет">
            <p>Вернитесь к основным разделам приложения.</p>
            <a className="button button--secondary" href="#/library">
              К библиотеке
            </a>
          </EmptyState>
        )}
        {route !== 'settings' &&
          route !== 'reading' &&
          status.state !== 'ready' && (
            <StatusCard status={status} onRetry={retry} />
          )}
        {route !== 'reading' && (
          <footer className="page-footer">
            <span>reedit</span>
            <span>Личное. Локальное. Ваше.</span>
          </footer>
        )}
      </main>
      <Panel
        open={overlay === 'storage'}
        title="На вашем устройстве"
        onClose={() => {
          setOverlay(null);
        }}
      >
        <div className="prose">
          <p>
            Книги, прочтения и записи хранятся локально в этом браузере.
            Перезагрузка страницы их не удаляет.
          </p>
          <p>
            Очистка данных сайта или удаление браузерного профиля удалит
            локальные данные. Браузер также может освободить занятое сайтом
            место.
          </p>
          <p>
            Резервную копию ZIP можно сохранить в Настройках. Облачной
            синхронизации нет.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            setOverlay(null);
          }}
        >
          Понятно
        </Button>
      </Panel>
      <Dialog
        open={overlay === 'about'}
        title="О Reedit"
        onClose={() => {
          setOverlay(null);
        }}
      >
        <div className="prose">
          <p>Спокойное место для ваших книг и мыслей о прочитанном.</p>
          <p>
            Сейчас доступны личная библиотека, прочтения, отзывы, коллекции,
            локальный импорт EPUB/FB2 и чтение с настройкой оформления и
            сохранением позиции, статистика, дневник и локальные резервные
            копии.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            setOverlay(null);
          }}
        >
          Закрыть окно
        </Button>
      </Dialog>
    </AppShell>
  );
}
