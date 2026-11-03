import type { ReactNode } from 'react';
import { Icon } from './Icon';
export function List({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <ul className="list" aria-label={label}>
      {children}
    </ul>
  );
}
export function ListItem({
  title,
  description,
  onClick,
}: {
  title: string;
  description?: string;
  onClick: () => void;
}) {
  return (
    <li>
      <button className="list__button" type="button" onClick={onClick}>
        <span>
          <span className="list__title">{title}</span>
          {description && (
            <span className="list__description">{description}</span>
          )}
        </span>
        <Icon name="arrow" />
      </button>
    </li>
  );
}
