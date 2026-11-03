import type { StorageStatus } from '../services/storage-status';
import { Button } from './Button';
import { Icon } from './Icon';
export function StatusCard({
  status,
  onRetry,
}: {
  status: StorageStatus;
  onRetry: () => void;
}) {
  return (
    <section
      className="status-card surface"
      aria-labelledby="storage-title"
      aria-busy={status.state === 'checking'}
    >
      <div className="section-heading">
        <h2 id="storage-title">Локальное хранилище</h2>
        <Icon name={status.state === 'error' ? 'alert' : 'device'} />
      </div>
      <p role="status" aria-live="polite">
        {status.state === 'checking'
          ? 'Проверяем возможность сохранения…'
          : status.state === 'ready'
            ? 'Готово к сохранению данных'
            : status.message}
      </p>
      {status.state === 'error' && (
        <Button variant="secondary" onClick={onRetry}>
          Повторить проверку
        </Button>
      )}
      <p className="caption">
        Книги и записи будут храниться в браузере этого устройства. Очистка
        данных сайта удалит их.
      </p>
    </section>
  );
}
