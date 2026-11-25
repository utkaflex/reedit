import { useId, useState } from 'react';
import {
  defaultReaderPreferences,
  type ReaderPreferences,
} from '../../domain/reader';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { SegmentedControl } from '../../ui/SegmentedControl';

function ReaderSpacingControl({
  label,
  value,
  canDecrease,
  canIncrease,
  onStep,
  size = false,
}: {
  label: string;
  value: string;
  canDecrease: boolean;
  canIncrease: boolean;
  onStep: (direction: -1 | 1) => void;
  size?: boolean;
}) {
  return (
    <div className="reader-spacing" role="group" aria-label={label}>
      <span>{label}</span>
      <div className="reader-size-control">
        <Button
          variant="secondary"
          aria-label={
            size
              ? 'Уменьшить шрифт'
              : `Уменьшить: ${label.toLocaleLowerCase('ru')}`
          }
          disabled={!canDecrease}
          onClick={() => {
            onStep(-1);
          }}
        >
          {size ? 'A−' : '−'}
        </Button>
        <output aria-label={size ? 'Текущий размер шрифта' : undefined}>
          {value}
        </output>
        <Button
          variant="secondary"
          aria-label={
            size
              ? 'Увеличить шрифт'
              : `Увеличить: ${label.toLocaleLowerCase('ru')}`
          }
          disabled={!canIncrease}
          onClick={() => {
            onStep(1);
          }}
        >
          {size ? 'A+' : '+'}
        </Button>
      </div>
    </div>
  );
}

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
  const formId = useId();
  const [draft, setDraft] = useState({ ...preferences });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      presentation="panel"
      title="Оформление чтения"
      className="reader-appearance"
      footer={
        <Button form={formId} type="submit" disabled={busy || navigationBusy}>
          {busy ? 'Применяем…' : 'Применить оформление'}
        </Button>
      }
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        id={formId}
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
          <ReaderSpacingControl
            label="Размер шрифта"
            size
            value={String(draft.fontSize)}
            canDecrease={draft.fontSize > 16}
            canIncrease={draft.fontSize < 32}
            onStep={(direction) => {
              setDraft((current) => ({
                ...current,
                fontSize: Math.max(
                  16,
                  Math.min(32, current.fontSize + direction),
                ),
              }));
            }}
          />
          <ReaderSpacingControl
            label="Межстрочный интервал"
            value={draft.lineHeight.toLocaleString('ru')}
            canDecrease={draft.lineHeight > 1.2}
            canIncrease={draft.lineHeight < 2.2}
            onStep={(direction) => {
              setDraft((current) => ({
                ...current,
                lineHeight:
                  Math.max(
                    12,
                    Math.min(
                      22,
                      Math.round(current.lineHeight * 10) + direction,
                    ),
                  ) / 10,
              }));
            }}
          />
          <ReaderSpacingControl
            label="Поля"
            value={`${String(draft.margin)} px`}
            canDecrease={draft.margin > 12}
            canIncrease={draft.margin < 48}
            onStep={(direction) => {
              setDraft((current) => ({
                ...current,
                margin: Math.max(
                  12,
                  Math.min(48, current.margin + direction * 4),
                ),
              }));
            }}
          />
          <div className="reader-settings-alignment">
            <SegmentedControl
              label="Выравнивание"
              value={draft.alignment}
              options={[
                { value: 'left', label: 'Слева' },
                { value: 'justify', label: 'По ширине' },
              ]}
              onChange={(alignment) => {
                setDraft({ ...draft, alignment });
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
      </form>
    </Dialog>
  );
}
