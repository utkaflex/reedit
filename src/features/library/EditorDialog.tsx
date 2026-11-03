import { useEffect, useState, type ReactNode } from 'react';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
export function EditorDialog({
  title,
  onClose,
  dirty,
  busy,
  children,
}: {
  title: string;
  onClose: () => void;
  dirty: boolean;
  busy: boolean;
  children: ReactNode;
}) {
  const [discard, setDiscard] = useState(false);
  useEffect(() => {
    if (!dirty) return;
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', preventUnload);
    return () => {
      window.removeEventListener('beforeunload', preventUnload);
    };
  }, [dirty]);
  return (
    <Dialog
      open
      title={title}
      onClose={() => {
        if (busy) return;
        if (dirty) setDiscard(true);
        else onClose();
      }}
    >
      <div hidden={discard}>{children}</div>
      {discard && (
        <div className="form-stack">
          <h3>Не сохранять изменения?</h3>
          <p className="caption">
            Изменения в этой форме будут потеряны. Сохранённые данные останутся
            на месте.
          </p>
          <Button
            variant="secondary"
            onClick={() => {
              setDiscard(false);
            }}
          >
            Продолжить редактирование
          </Button>
          <Button variant="danger" onClick={onClose}>
            Не сохранять
          </Button>
        </div>
      )}
    </Dialog>
  );
}
