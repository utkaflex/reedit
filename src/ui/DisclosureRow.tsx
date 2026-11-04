import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/** A native disclosure keeps form state and keyboard access when collapsed. */
export function DisclosureRow({
  title,
  detail,
  icon,
  children,
}: {
  title: string;
  detail?: string;
  icon: IconName;
  children: ReactNode;
}) {
  return (
    <details className="disclosure-row">
      <summary>
        <Icon name={icon} />
        <span>
          <strong>{title}</strong>
          {detail && <small>{detail}</small>}
        </span>
        <Icon name="arrow" />
      </summary>
      <div className="disclosure-row__body">{children}</div>
    </details>
  );
}
