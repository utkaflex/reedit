import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Icon, type IconName } from '../../src/ui/Icon';

export function showIconSample() {
  const panel = document.createElement('section');
  panel.id = 'icon-sample';
  panel.style.cssText =
    'position:fixed;inset:0 auto auto 0;z-index:1000;width:min(100%,420px);padding:16px;background:var(--color-surface);color:var(--color-text);display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px';
  document.body.append(panel);
  const entries: [IconName, string][] = [
    ['back', 'Назад'],
    ['arrow', 'Переход'],
    ['expand', 'Раскрыть'],
    ['close', 'Закрыть'],
    ['previous', 'Предыдущая'],
    ['next', 'Следующая'],
    ['quote', 'Цитаты'],
    ['settings', 'Настройки'],
    ['filter', 'Фильтры'],
    ['hide', 'Скрыть панели'],
  ];
  createRoot(panel).render(
    entries.map(([name, label]) =>
      createElement(
        'div',
        {
          key: name,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            fontSize: '13px',
          },
        },
        createElement(
          'span',
          {
            className: 'button button--secondary icon-button',
            style: { width: '44px', flex: 'none' },
          },
          createElement(Icon, { name }),
        ),
        label,
      ),
    ),
  );
}
