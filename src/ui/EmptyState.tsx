import { Icon, type IconName } from './Icon';
export function EmptyState({
  icon,
  title,
  children,
}: {
  icon: IconName;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="empty-state">
      <div className="empty-state__icon">
        <Icon name={icon} />
      </div>
      <h2>{title}</h2>
      <div className="empty-state__description">{children}</div>
    </section>
  );
}
