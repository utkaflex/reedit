/** Presentation only: durations are already grouped by the domain in local days. */
export function ActivityChart({
  days,
  year,
}: {
  days: Map<string, number>;
  year: number;
}) {
  const months = Array.from({ length: 12 }, (_, month) => {
    const prefix = `${String(year)}-${String(month + 1).padStart(2, '0')}`;
    const time = [...days].reduce(
      (sum, [day, value]) => (day.startsWith(prefix) ? sum + value : sum),
      0,
    );
    return {
      label: new Date(Date.UTC(year, month, 1))
        .toLocaleDateString('ru', { month: 'short', timeZone: 'UTC' })
        .replace('.', '')
        .slice(0, 3),
      time,
    };
  });
  const max = Math.max(...months.map((month) => month.time));
  if (max <= 0) return null;
  return (
    <section className="activity-overview" aria-label="Активность за год">
      <h2>Ваш ритм</h2>
      <div className="activity-months">
        {months.map(({ label, time }) => (
          <div
            key={label}
            role="img"
            aria-label={`${label}: ${time > 0 && time < 60000 ? '<1' : String(Math.round(time / 60000))} мин`}
          >
            <span style={{ height: `${String((time / max) * 100)}%` }} />
            <small aria-hidden="true">{label}</small>
          </div>
        ))}
      </div>
    </section>
  );
}
