import { useRef, useState } from 'react';
import type { Reading } from '../../domain/model';
import type { LocalStore } from '../../domain/repositories';
import { dateInput, statusLabels, today } from '../../domain/library';
import { editReading } from '../../services/library';
import { TextField } from '../../ui/TextField';
import { SelectField, TextArea } from '../../ui/FormControls';
import { Button } from '../../ui/Button';
import { EditorDialog } from './EditorDialog';

export function ReadingEditor({
  reading,
  store,
  onSaved,
  onClose,
}: {
  reading: Reading;
  store: LocalStore;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const [status, setStatus] = useState(reading.status);
  const [start, setStart] = useState(dateInput(reading.startedAt));
  const [finish, setFinish] = useState(dateInput(reading.finishedAt));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <EditorDialog
      title="Редактировать прочтение"
      dirty={dirty}
      busy={busy}
      onClose={onClose}
    >
      <form
        className="form-stack"
        aria-busy={busy}
        onChange={() => {
          setDirty(true);
          setError(null);
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (lock.current) return;
          const values = new FormData(event.currentTarget);
          const text = (name: string) => {
            const value = values.get(name);
            return typeof value === 'string' ? value : '';
          };
          lock.current = true;
          setBusy(true);
          setError(null);
          void (async () => {
            try {
              const updated = editReading(reading, {
                status,
                startedAt: start,
                finishedAt: finish,
                rating: text('rating'),
                review: text('review'),
              });
              await store.repositories.readings.save(updated, {
                expectedUpdatedAt: reading.updatedAt,
              });
              await onSaved();
            } catch (reason) {
              setError(
                reason instanceof Error
                  ? reason.message
                  : 'Не удалось сохранить прочтение.',
              );
            } finally {
              lock.current = false;
              setBusy(false);
            }
          })();
        }}
      >
        <fieldset className="form-stack form-fieldset" disabled={busy}>
          <SelectField
            label="Статус"
            value={status}
            onChange={(event) => {
              const next = event.target.value;
              if (!(next in statusLabels)) return;
              const value = next as Reading['status'];
              setStatus(value);
              if ((value === 'active' || value === 'finished') && !start)
                setStart(today());
              if (value === 'finished' && !finish) setFinish(today());
            }}
          >
            {Object.entries(statusLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </SelectField>
          {(status !== 'planned' || start) && (
            <TextField
              label="Дата начала"
              type="date"
              value={start}
              onChange={(event) => {
                setStart(event.target.value);
              }}
              required={status === 'active' || status === 'finished'}
            />
          )}
          {(status === 'finished' || status === 'abandoned' || finish) && (
            <TextField
              label="Дата завершения"
              type="date"
              value={finish}
              onChange={(event) => {
                setFinish(event.target.value);
              }}
              required={status === 'finished'}
            />
          )}
          <p className="caption">
            {status === 'planned'
              ? 'В планах — даты пока не нужны.'
              : status === 'finished'
                ? 'Укажите период этого прочтения.'
                : 'Дату начала можно уточнить вручную.'}
          </p>
          <SelectField
            label="Оценка"
            name="rating"
            defaultValue={reading.rating ?? ''}
          >
            <option value="">Без оценки</option>
            {Array.from({ length: 10 }, (_, index) => (index + 1) / 2).map(
              (value) => (
                <option key={value} value={value}>
                  {value.toLocaleString('ru')} из 5
                </option>
              ),
            )}
          </SelectField>
          <TextArea
            label="Личный отзыв"
            name="review"
            defaultValue={reading.review}
            maxLength={30000}
          />
          <p className="caption">
            Оценка и отзыв относятся только к этому прочтению.
          </p>
        </fieldset>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy}>
          {busy ? 'Сохраняем…' : 'Сохранить прочтение'}
        </Button>
      </form>
    </EditorDialog>
  );
}
