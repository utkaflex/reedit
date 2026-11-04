import { useEffect, useRef, type ReactNode } from 'react';
import type { Route, Section } from '../features/shell/navigation';
import { Icon, type IconName } from './Icon';
const destinations: { section: Section; label: string; icon: IconName }[] = [
  { section: 'library', label: 'Библиотека', icon: 'library' },
  { section: 'quotes', label: 'Цитаты', icon: 'quote' },
  { section: 'statistics', label: 'Статистика', icon: 'chart' },
  { section: 'settings', label: 'Настройки', icon: 'settings' },
];
export function AppShell({
  route,
  children,
}: {
  route: Route;
  children: ReactNode;
}) {
  const shell = useRef<HTMLDivElement>(null);
  const navigation = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = navigation.current;
    const root = shell.current;
    if (!nav || !root) return;
    const measure = () => {
      root.style.setProperty(
        '--navigation-space',
        `${String(Math.ceil(nav.getBoundingClientRect().height))}px`,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    measure();
    return () => {
      observer.disconnect();
    };
  }, [route]);
  const skipLink = (
    <a
      className="skip-link"
      href="#main-content"
      onClick={(event) => {
        event.preventDefault();
        const main = document.getElementById('main-content');
        main?.focus();
        main?.scrollIntoView();
      }}
    >
      К содержимому
    </a>
  );
  if (route === 'reading')
    return (
      <div className="reading-shell">
        {skipLink}
        {children}
      </div>
    );
  return (
    <div className="app-shell" ref={shell}>
      {skipLink}
      <aside className="app-rail">
        <a className="brand" href="#/library" aria-label="Reedit — Библиотека">
          reedit<span className="brand__dot">.</span>
        </a>
        <span className="rail-caption">
          Личное пространство
          <br />
          для чтения
        </span>
      </aside>
      <nav
        ref={navigation}
        className="navigation"
        aria-label="Основные разделы"
      >
        {destinations.map(({ section, label, icon }) => (
          <a
            key={section}
            href={`#/${section}`}
            aria-current={route === section ? 'page' : undefined}
          >
            <Icon name={icon} />
            <span>{label}</span>
          </a>
        ))}
      </nav>
      <div className="app-content">{children}</div>
      <div className="rail-footer">
        <Icon name="device" />
        <span>
          Только на вашем
          <br />
          устройстве
        </span>
      </div>
    </div>
  );
}
