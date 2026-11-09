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
  pause,
}: {
  snapshot: SpeedSnapshot;
  pause: () => void;
}) {
  const parts = focusParts(snapshot.word);
  const focus =
    snapshot.preferences.focusLetter && Array.from(snapshot.word).length <= 40;
  return (
    <div className="rsvp-stage" onPointerDown={pause}>
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
          ? 'Коснитесь страницы, чтобы остановиться'
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
      <div className="speed-status">
        <span role="status">
          {snapshot.preparing
            ? 'Готовим текст…'
            : snapshot.ended
              ? 'Книга закончилась'
              : snapshot.playing
                ? 'Воспроизведение'
                : 'Пауза'}
        </span>
        <span aria-live="off" data-testid="speed-ordinal">
          {snapshot.ordinal} / {snapshot.total}
        </span>
      </div>
      <progress
        className="speed-progress"
        aria-label="Прогресс скорочтения"
        max={Math.max(1, snapshot.total)}
        value={snapshot.ordinal}
      />
      {snapshot.mode === 'guided' && (
        <p className="caption">С подсветкой текста · касание ставит на паузу</p>
      )}
      <div className="speed-buttons speed-transport">
        <Button
          variant="quiet"
          aria-label="Назад по словам"
          disabled={
            snapshot.preparing || snapshot.busy || snapshot.ordinal <= 1
          }
          onClick={() => {
            run((session) => session.seek('back'));
          }}
        >
          <Icon name="previous" />
        </Button>
        <Button
          className="speed-play"
          aria-label={snapshot.playing ? 'Пауза' : 'Продолжить'}
          disabled={
            snapshot.preparing ||
            snapshot.ordinal === 0 ||
            (!snapshot.playing && snapshot.busy) ||
            snapshot.ended
          }
          onClick={() => {
            if (snapshot.playing) service?.pause();
            else run((session) => session.play());
          }}
        >
          <Icon name={snapshot.playing ? 'pause' : 'play'} />
        </Button>
        <Button
          variant="quiet"
          aria-label="Вперёд по словам"
          disabled={
            snapshot.preparing ||
            snapshot.busy ||
            snapshot.ordinal >= snapshot.total
          }
          onClick={() => {
            run((session) => session.seek('forward'));
          }}
        >
          <Icon name="next" />
        </Button>
        <Button
          variant="quiet"
          className="speed-repeat"
          aria-label="Предыдущее предложение"
          disabled={
            snapshot.preparing || snapshot.busy || snapshot.ordinal === 0
          }
          onClick={() => {
            run((session) => session.seek('sentence'));
          }}
        >
          <Icon name="repeat" />
        </Button>
      </div>
      <div className="speed-buttons">
        <Button
          variant="quiet"
          onClick={() => {
            service?.pause();
            setSettings(structuredClone(snapshot.preferences));
          }}
          disabled={snapshot.preparing}
        >
          <Icon name="settings" /> {p.wpm} WPM · Настройки
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            run((session) => session.stop());
          }}
        >
          <Icon name="book" /> Вернуться к тексту
        </Button>
      </div>
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
            <TextField
              label={`Скорость: ${String(p.wpm)} слов/мин`}
              type="range"
              min={100}
              max={900}
              step={10}
              value={p.wpm}
              disabled={snapshot.busy}
              onChange={(event) => {
                configure({ ...p, wpm: Number(event.target.value) });
              }}
            />
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
              <TextField
                label="Слов в подсветке"
                type="number"
                min={1}
                max={12}
                value={p.guidedWords}
                disabled={snapshot.busy}
                onChange={(event) => {
                  configure({ ...p, guidedWords: Number(event.target.value) });
                }}
              />
            )}
            <details>
              <summary>Интеллектуальные паузы</summary>
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
            </details>
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
