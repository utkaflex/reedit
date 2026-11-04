import { useEffect, useState } from 'react';
import type { LocalStore } from '../../domain/repositories';
import { activityDays, localDay } from '../../domain/statistics';

/** Same persisted activity intervals and civil-day grouping as Statistics. */
export function WeeklyReading({ store }: { store: LocalStore }) {
  const [now] = useState(() => Date.now());
  const [days, setDays] = useState<Map<string, number> | null>(null);
  useEffect(() => {
    let alive = true;
    void store.readStatistics().then(
      (data) => {
        if (alive)
          setDays(
            activityDays(
              data.activities,
              Intl.DateTimeFormat().resolvedOptions().timeZone,
            ),
          );
      },
      () => {
        /* Optional summary must not block the library or hide its error state. */
      },
    );
    return () => {
      alive = false;
    };
  }, [store]);
  if (!days) return null;
  const today = localDay(now, Intl.DateTimeFormat().resolvedOptions().timeZone);
  const end = Date.parse(`${today}T12:00:00Z`);
  const week = Array.from({ length: 7 }, (_, n) => {
    const date = new Date(end - (6 - n) * 86400000);
    const day = date.toISOString().slice(0, 10);
    return {
      day,
      label: date.toLocaleDateString('ru', {
        weekday: 'short',
        timeZone: 'UTC',
      }),
      time: days.get(day) ?? 0,
    };
  });
  const total = week.reduce((sum, day) => sum + day.time, 0);
  if (total <= 0) return null;
  const minutes = Math.floor(total / 60000);
  const duration =
    minutes >= 60
      ? `${String(Math.floor(minutes / 60))} ч ${String(minutes % 60)} мин`
      : minutes > 0
        ? `${String(minutes)} мин`
        : 'Меньше минуты';
  const max = Math.max(...week.map((day) => day.time));
  return (
    <section
      className="weekly-reading"
      aria-label="Чтение за последние семь дней"
    >
      <h2>Чтение за 7 дней</h2>
      <strong>{duration}</strong>
      <div className="weekly-bars">
        {week.map((day) => (
          <div
            key={day.day}
            title={`${day.day}: ${String(Math.round(day.time / 60000))} мин`}
          >
            <span style={{ height: `${String((day.time / max) * 100)}%` }} />
            <small>{day.label}</small>
          </div>
        ))}
      </div>
      <a href="#/statistics">Вся статистика →</a>
    </section>
  );
}
