import { useId, useState } from 'react';
import {
  defaultReaderPreferences,
  type ReaderPreferences,
} from '../../domain/reader';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { SegmentedControl } from '../../ui/SegmentedControl';

export function ReaderSettings({
  preferences,
  navigationBusy,
  onClose,
  onApply,
}: {
  preferences: ReaderPreferences;
  navigationBusy: boolean;
  onClose: () => void;
  onApply: (next: ReaderPreferences) => Promise<void>;
}) {
  const [draft, setDraft] = useState({ ...preferences });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  return (
    <Dialog
      open
      presentation="panel"
      title="Оформление чтения"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="form-stack reader-settings"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || navigationBusy) return;
          setBusy(true);
          setError(null);
          void onApply(draft)
            .then(onClose, (reason: unknown) => {
              setError(
                reason instanceof Error
                  ? reason.message
                  : 'Не удалось изменить оформление',
              );
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        <fieldset className="form-stack form-fieldset" disabled={busy}>
          <div className="reader-theme-picker">
            <SegmentedControl
              label="Тема чтения"
              value={draft.theme}
              options={[
                { value: 'light', label: 'Светлая' },
                { value: 'sepia', label: 'Сепия' },
                { value: 'dark', label: 'Тёмная' },
              ]}
              onChange={(theme) => {
                setDraft({ ...draft, theme });
              }}
            />
          </div>
          <SegmentedControl
            label="Режим чтения"
            value={draft.mode}
            options={[
              { value: 'paginated', label: 'Страницы' },
              { value: 'scroll', label: 'Прокрутка' },
            ]}
            onChange={(mode) => {
              setDraft({ ...draft, mode });
            }}
          />
          <div className="reader-font-picker">
            <SegmentedControl
              label="Шрифт чтения"
              value={draft.font}
              options={[
                { value: 'serif', label: 'Книжный' },
                { value: 'sans', label: 'Системный' },
              ]}
              onChange={(font) => {
                setDraft({ ...draft, font });
              }}
            />
          </div>
          <div
            className="reader-size-control"
            role="group"
            aria-label="Размер шрифта"
          >
            <Button
              variant="secondary"
              aria-label="Уменьшить шрифт"
              disabled={draft.fontSize <= 16}
              onClick={() => {
                setDraft({ ...draft, fontSize: draft.fontSize - 1 });
              }}
            >
              A−
            </Button>
            <output aria-label="Текущий размер шрифта">{draft.fontSize}</output>
            <Button
              variant="secondary"
              aria-label="Увеличить шрифт"
              disabled={draft.fontSize >= 32}
              onClick={() => {
                setDraft({ ...draft, fontSize: draft.fontSize + 1 });
              }}
            >
              A+
            </Button>
          </div>
          <label className="reader-range" htmlFor={`${id}-line`}>
            Межстрочный интервал{' '}
            <output>{draft.lineHeight.toLocaleString('ru')}</output>
            <input
              id={`${id}-line`}
              aria-label="Межстрочный интервал"
              type="range"
              min="1.2"
              max="2.2"
              step="0.1"
              value={draft.lineHeight}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  lineHeight: Number(event.target.value),
                });
              }}
            />
          </label>
          <label className="reader-range" htmlFor={`${id}-margin`}>
            Поля <output>{draft.margin} px</output>
            <input
              id={`${id}-margin`}
              aria-label="Поля"
              type="range"
              min="12"
              max="48"
              step="4"
              value={draft.margin}
              onChange={(event) => {
                setDraft({ ...draft, margin: Number(event.target.value) });
              }}
            />
          </label>
          <SegmentedControl
            label="Выравнивание"
            value={draft.alignment}
            options={[
              { value: 'left', label: 'По левому краю' },
              { value: 'justify', label: 'По ширине' },
            ]}
            onChange={(alignment) => {
              setDraft({ ...draft, alignment });
            }}
          />
          <label className="import-checkbox">
            <input
              type="checkbox"
              checked={draft.animations}
              onChange={(event) => {
                setDraft({ ...draft, animations: event.target.checked });
              }}
            />
            <span>Плавные переходы панелей</span>
          </label>
        </fieldset>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <Button
          variant="quiet"
          disabled={busy}
          onClick={() => {
            setDraft({ ...defaultReaderPreferences });
          }}
        >
          Стандартное оформление
        </Button>
        <Button type="submit" disabled={busy || navigationBusy}>
          {busy ? 'Применяем…' : 'Применить оформление'}
        </Button>
      </form>
    </Dialog>
  );
}
