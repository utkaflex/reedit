import { useState } from 'react';
import {
  focusParts,
  validSpeedPreferences,
  type SpeedPreferences,
} from '../../domain/speed-reading';
import type {
  SpeedReadingService,
  SpeedSnapshot,
} from '../../services/speed-reading';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { TextField } from '../../ui/TextField';
import { Icon } from '../../ui/Icon';
import './speed-reading.css';

export function RsvpWord({
  snapshot,
  toggleControls,
}: {
  snapshot: SpeedSnapshot;
  toggleControls: () => void;
}) {
  const parts = focusParts(snapshot.word);
  const focus =
    snapshot.preferences.focusLetter && Array.from(snapshot.word).length <= 40;
  return (
    <div className="rsvp-stage" onClick={toggleControls}>
      <p className="rsvp-heading">
        <span>Чтение по словам</span>
        <span>{snapshot.preferences.wpm} слов/мин</span>
      </p>
      <output
        className={`rsvp-word ${focus ? 'rsvp-word--focus' : ''}`}
        aria-label="Текущее слово"
        aria-live="off"
        style={{
          fontSize: `${String(Math.max(14, Math.min(40, 600 / Math.max(1, Array.from(snapshot.word).length))))}px`,
        }}
      >
        {snapshot.preparing ? (
          'Подготовка…'
        ) : focus ? (
          <>
            <span>{parts[0]}</span>
            <strong>{parts[1]}</strong>
            <span>{parts[2]}</span>
          </>
        ) : (
          snapshot.word || 'Нет слов'
        )}
      </output>
      <p className="caption rsvp-hint">
        {snapshot.playing
          ? ''
          : snapshot.ended
            ? 'Вы дошли до конца книги'
            : 'Продолжите, когда будете готовы'}
      </p>
    </div>
  );
}
const pauseLabels: Record<keyof SpeedPreferences['pauses'], string> = {
  ordinary: 'Обычное слово',
  long: 'Длинное слово',
  comma: 'Запятая',
  sentence: 'Конец предложения',
  paragraph: 'Конец абзаца',
};
export function SpeedControls({
  snapshot,
  run,
  service,
}: {
  snapshot: SpeedSnapshot;
  run: (action: (service: SpeedReadingService) => Promise<void>) => void;
  service: SpeedReadingService | null;
}) {
  const [settings, setSettings] = useState<SpeedPreferences | null>(null);
  const p = settings ?? snapshot.preferences;
  const configure = (next: SpeedPreferences) => {
    setSettings(next);
  };
  return (
    <section
      className="speed-controls"
      aria-label="Управление скорочтением"
      onKeyDown={(event) => {
        if (
          event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement ||
          settings
        )
          return;
        if (event.key === ' ' && event.target === event.currentTarget) {
          event.preventDefault();
          if (snapshot.playing) service?.pause();
          else run((session) => session.play());
        }
      }}
    >
      <div className="speed-inline">
        <Button
          variant="quiet"
          aria-label="Уменьшить скорость"
          disabled={snapshot.preparing || p.wpm <= 100}
          onClick={() => {
            run((session) => session.adjustSpeed(-10));
          }}
        >
          −
        </Button>
        <Button
          variant="quiet"
          onClick={() => {
            service?.pause();
            setSettings(structuredClone(snapshot.preferences));
          }}
        >
          {p.wpm} слов/мин
        </Button>
        <Button
          variant="quiet"
          aria-label="Увеличить скорость"
          disabled={snapshot.preparing || p.wpm >= 900}
          onClick={() => {
            run((session) => session.adjustSpeed(10));
          }}
        >
          +
        </Button>
        <Button
          aria-label={snapshot.playing ? 'Пауза' : 'Продолжить'}
          disabled={
            snapshot.preparing || snapshot.ended || snapshot.ordinal === 0
          }
          onClick={() => {
            if (snapshot.playing) service?.pause();
            else run((session) => session.play());
          }}
        >
          <Icon name={snapshot.playing ? 'pause' : 'play'} />
        </Button>
      </div>
      {snapshot.ended && (
        <p role="status" className="caption">
          Книга закончилась
        </p>
      )}
      {snapshot.error && (
        <p className="error-text" role="alert">
          {snapshot.error}
        </p>
      )}
      {settings && (
        <Dialog
          open
          presentation="panel"
          title="Настройки скорочтения"
          onClose={() => {
            setSettings(null);
          }}
        >
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              if (!validSpeedPreferences(settings)) return;
              run(async (session) => {
                await session.configure(settings);
                setSettings(null);
              });
            }}
          >
            <label className="speed-step-label">
              Скорость · 100–900 слов/мин
            </label>
            <div className="speed-stepper">
              <Button
                variant="secondary"
                aria-label="Медленнее"
                onClick={() => {
                  configure({ ...p, wpm: Math.max(100, p.wpm - 10) });
                }}
              >
                −
              </Button>
              <TextField
                label="Слов в минуту"
                type="number"
                inputMode="numeric"
                min={100}
                max={900}
                step={1}
                value={p.wpm}
                onChange={(event) => {
                  configure({ ...p, wpm: Number(event.target.value) });
                }}
              />
              <Button
                variant="secondary"
                aria-label="Быстрее"
                onClick={() => {
                  configure({ ...p, wpm: Math.min(900, p.wpm + 10) });
                }}
              >
                +
              </Button>
            </div>
            {snapshot.mode === 'rsvp' ? (
              <label className="speed-checkbox">
                <input
                  type="checkbox"
                  checked={p.focusLetter}
                  disabled={snapshot.busy}
                  onChange={(event) => {
                    configure({ ...p, focusLetter: event.target.checked });
                  }}
                />
                Выделять опорную букву
              </label>
            ) : (
              <div className="speed-stepper">
                <Button
                  variant="secondary"
                  aria-label="Меньше слов"
                  onClick={() => {
                    configure({
                      ...p,
                      guidedWords: Math.max(1, p.guidedWords - 1),
                    });
                  }}
                >
                  −
                </Button>
                <TextField
                  label="Слов в подсветке"
                  type="number"
                  min={1}
                  max={12}
                  readOnly
                  value={p.guidedWords}
                  disabled={snapshot.busy}
                  onChange={(event) => {
                    configure({
                      ...p,
                      guidedWords: Number(event.target.value),
                    });
                  }}
                />
                <Button
                  variant="secondary"
                  aria-label="Больше слов"
                  onClick={() => {
                    configure({
                      ...p,
                      guidedWords: Math.min(12, p.guidedWords + 1),
                    });
                  }}
                >
                  +
                </Button>
              </div>
            )}
            {snapshot.mode === 'guided' && (
              <label className="speed-checkbox">
                <input
                  type="checkbox"
                  checked={p.centerFocus !== false}
                  onChange={(event) => {
                    configure({ ...p, centerFocus: event.target.checked });
                  }}
                />
                Фокус по центру
              </label>
            )}
            <section>
              <h3>Интеллектуальные паузы</h3>
              <div className="form-stack">
                {Object.entries(pauseLabels).map(([key, label]) => (
                  <TextField
                    key={key}
                    label={`Множитель: ${label}`}
                    type="number"
                    min={0.5}
                    max={6}
                    step={0.1}
                    value={p.pauses[key as keyof typeof p.pauses]}
                    disabled={snapshot.busy}
                    onChange={(event) => {
                      configure({
                        ...p,
                        pauses: {
                          ...p.pauses,
                          [key]: Number(event.target.value),
                        },
                      });
                    }}
                  />
                ))}
                <TextField
                  label="Длинное слово: букв от"
                  type="number"
                  min={4}
                  max={40}
                  value={p.longWordLength}
                  disabled={snapshot.busy}
                  onChange={(event) => {
                    configure({
                      ...p,
                      longWordLength: Number(event.target.value),
                    });
                  }}
                />
                <p className="caption">
                  При сочетании знаков применяется самый большой множитель.
                  Настройки сохраняются на устройстве. Изменение настройки
                  оставляет чтение на паузе.
                </p>
              </div>
            </section>
            {snapshot.error && <p role="alert">{snapshot.error}</p>}
            <Button
              type="submit"
              disabled={snapshot.busy || !validSpeedPreferences(p)}
            >
              Применить настройки
            </Button>
          </form>
        </Dialog>
      )}
    </section>
  );
}
