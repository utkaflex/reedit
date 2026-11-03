import { useId, useState } from 'react';
import type { ReaderPreferences } from '../../domain/reader';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { SelectField } from '../../ui/FormControls';

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
      title="Оформление чтения"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="form-stack"
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
          <SelectField
            label="Шрифт чтения"
            value={draft.font}
            onChange={(event) => {
              setDraft({
                ...draft,
                font: event.target.value === 'sans' ? 'sans' : 'serif',
              });
            }}
          >
            <option value="serif">С засечками · системный книжный</option>
            <option value="sans">Без засечек · системный</option>
          </SelectField>
          <label className="reader-range" htmlFor={`${id}-size`}>
            Размер шрифта <output>{draft.fontSize} px</output>
            <input
              id={`${id}-size`}
              aria-label="Размер шрифта"
              type="range"
              min="16"
              max="32"
              step="1"
              value={draft.fontSize}
              onChange={(event) => {
                setDraft({ ...draft, fontSize: Number(event.target.value) });
              }}
            />
          </label>
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
                setDraft({ ...draft, lineHeight: Number(event.target.value) });
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
          <p className="caption">
            В прокрутке текст раздела движется вертикально, а кнопки переводят к
            предыдущему или следующему разделу. Системное уменьшение движения
            имеет приоритет.
          </p>
        </fieldset>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy || navigationBusy}>
          {busy ? 'Применяем…' : 'Применить оформление'}
        </Button>
      </form>
    </Dialog>
  );
}
