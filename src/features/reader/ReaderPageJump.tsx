import { useState } from 'react';
import type { ReaderLocation } from '../../domain/reader';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';

export function ReaderPageJump({
  chapter,
  page,
  busy,
  onClose,
  onJump,
}: {
  chapter: string;
  page: NonNullable<ReaderLocation['page']>;
  busy: boolean;
  onClose: () => void;
  onJump: (number: number) => Promise<boolean>;
}) {
  const [value, setValue] = useState(String(page.number));
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog
      open
      presentation="panel"
      title="Перейти к странице"
      className="reader-page-jump"
      onClose={onClose}
    >
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          setError(null);
          void onJump(Number(value))
            .then((moved) => {
              if (moved) onClose();
            })
            .catch((reason: unknown) => {
              setError(
                reason instanceof Error
                  ? reason.message
                  : 'Не удалось открыть страницу.',
              );
            });
        }}
      >
        {chapter && (
          <p>
            <strong>{chapter}</strong>
          </p>
        )}
        <div className="reader-page-jump__position">
          <strong>Сейчас страница {page.number}</strong>
          <span>Страницы всей книги · от 1 до {page.total}</span>
        </div>
        <label className="field">
          <span>Номер страницы</span>
          <input
            type="text"
            inputMode="numeric"
            enterKeyHint="go"
            pattern="[0-9]+"
            required
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
        </label>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy}>
          Перейти
        </Button>
      </form>
    </Dialog>
  );
}
