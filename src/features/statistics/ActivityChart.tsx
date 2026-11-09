import { useState } from 'react';
import { SelectField } from '../../ui/FormControls';

/** Presentation only: durations are already grouped by the domain in local days. */
export function ActivityChart({
  days,
  year,
}: {
  days: Map<string, number>;
  year: number;
}) {
  const [selectedMonth, setSelectedMonth] = useState<number | null>(null);
  const months = Array.from({ length: 12 }, (_, month) => {
    const prefix = `${String(year)}-${String(month + 1).padStart(2, '0')}`;
    const time = [...days].reduce(
      (sum, [day, value]) => (day.startsWith(prefix) ? sum + value : sum),
      0,
    );
    return {
      fullLabel: new Date(Date.UTC(year, month, 1)).toLocaleDateString('ru', {
        month: 'long',
        timeZone: 'UTC',
      }),
      label: new Date(Date.UTC(year, month, 1))
        .toLocaleDateString('ru', { month: 'short', timeZone: 'UTC' })
        .replace('.', '')
        .slice(0, 3),
      time,
    };
  });
  const max = Math.max(...months.map((month) => month.time));
  if (max <= 0) return null;
  const active =
    selectedMonth ??
    months.reduce((last, month, index) => (month.time > 0 ? index : last), 0);
  const minutes = (time: number) =>
    time > 0 && time < 60000 ? '<1' : String(Math.round(time / 60000));
  return (
    <section className="activity-overview" aria-label="Активность за год">
      <h2>Время чтения</h2>
      <p className="caption">{year} · минуты по месяцам</p>
      <div className="activity-months">
        {months.map(({ label, time }, index) => (
          <div
            key={label}
            data-selected={index === active}
            role="img"
            aria-label={`${label}: ${time > 0 && time < 60000 ? '<1' : String(Math.round(time / 60000))} мин`}
          >
            <span style={{ height: `${String((time / max) * 100)}%` }} />
            <small aria-hidden="true">{label}</small>
          </div>
        ))}
      </div>
      <div className="activity-value">
        <SelectField
          label="Месяц"
          value={String(active)}
          onChange={(event) => {
            setSelectedMonth(Number(event.target.value));
          }}
        >
          {months.map((month, index) => (
            <option key={month.label} value={String(index)}>
              {month.fullLabel}
            </option>
          ))}
        </SelectField>
        <output aria-live="polite">
          {minutes(months[active]?.time ?? 0)} мин
        </output>
      </div>
    </section>
  );
}
