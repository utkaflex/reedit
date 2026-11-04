import { ActivityChart } from './ActivityChart';
import { useCallback, useEffect, useRef, useState } from 'react';
import { newId, type Id, type Reading } from '../../domain/model';
import type { LocalStore } from '../../domain/repositories';
import {
  intervalWords,
  localDay,
  statistics,
  yearDays,
  type JournalEntry,
  type StatisticsSnapshot,
} from '../../domain/statistics';
import { dateInput, statusLabels } from '../../domain/library';
import { Button } from '../../ui/Button';
import { TextField } from '../../ui/TextField';
import { SelectField, TextArea } from '../../ui/FormControls';
import { Dialog } from '../../ui/Dialog';
import { EditorDialog } from '../library/EditorDialog';
import { ReadingEditor } from '../library/ReadingEditor';
import { BookEditor } from '../library/BookEditor';
import './statistics.css';

const modeLabels = {
  ordinary: 'Обычное чтение',
  rsvp: 'RSVP',
  guided: 'Guided Reading',
};
function duration(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60000);
  return minutes >= 60
    ? `${String(Math.floor(minutes / 60))} ч ${String(minutes % 60)} мин`
    : minutes > 0
      ? `${String(minutes)} мин`
      : milliseconds > 0
        ? 'меньше минуты'
        : '0 мин';
}
export function StatisticsPage({ store }: { store: LocalStore }) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [now, setNow] = useState(() => Date.now());
  const currentYear = Number(localDay(now, zone).slice(0, 4));
  const [year, setYear] = useState(currentYear);
  const [data, setData] = useState<StatisticsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const alive = useRef(true);
  const [reading, setReading] = useState<Reading | null>(null);
  const [paper, setPaper] = useState(false);
  const [entry, setEntry] = useState<JournalEntry | 'new' | null>(null);
  const [remove, setRemove] = useState<JournalEntry | null>(null);
  const refresh = useCallback(async () => {
    try {
      const next = await store.readStatistics();
      if (alive.current) {
        setData(next);
        setNow(Date.now());
        setError(null);
      }
    } catch (reason) {
      if (alive.current)
        setError(
          reason instanceof Error
            ? reason.message
            : 'Не удалось загрузить статистику.',
        );
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [store]);
  useEffect(() => {
    alive.current = true;
    void Promise.resolve().then(refresh);
    const visible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      alive.current = false;
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Не удалось сохранить.',
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  if (loading) return <p role="status">Собираем вашу историю чтения…</p>;
  if (!data)
    return (
      <div role="alert">
        <p>{error}</p>
        <Button
          onClick={() => {
            void refresh();
          }}
        >
          Повторить загрузку
        </Button>
      </div>
    );
  const summary = statistics(data, year, now, zone);
  const hasSummary = summary.yearly.length > 0 || summary.yearTime > 0;
  const goal = data.settings[0]?.readingGoals?.[String(year)] ?? 0;
  const years = [
    ...new Set([
      currentYear,
      year,
      ...data.readings.flatMap((r) =>
        r.finishedAt ? [new Date(r.finishedAt).getUTCFullYear()] : [],
      ),
      ...data.activities.map((e) => Number(localDay(e.from, zone).slice(0, 4))),
      ...Object.keys(data.settings[0]?.readingGoals ?? {}).map(Number),
    ]),
  ].sort((a, b) => b - a);
  const bookTitle = (id: Id) =>
    data.books.find((b) => b.id === id)?.title ?? 'Книга недоступна';
  const current = data.readings.filter(
    (r) => r.status === 'active' || r.status === 'paused',
  );
  const calendar = yearDays(year);
  const offset =
    (new Date(`${String(calendar[0])}T12:00:00Z`).getUTCDay() + 6) % 7;
  const paperAction = (
    <Button
      className="statistics-paper-action"
      variant="quiet"
      onClick={() => {
        setPaper(true);
      }}
    >
      Добавить бумажную книгу
    </Button>
  );
  return (
    <div className="statistics-page">
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <div className="statistics-toolbar statistics-year-picker">
        <SelectField
          label="Год"
          value={year}
          onChange={(e) => {
            setYear(Number(e.target.value));
          }}
        >
          {years.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </SelectField>
      </div>
      {hasSummary ? (
        <section className="statistics-summary" aria-label="Годовая сводка">
          <p className="caption">Ваш {year} год</p>
          <dl className="statistics-facts statistics-overview-facts">
            <div>
              <dt>Прочитано книг</dt>
              <dd>{summary.booksYear}</dd>
            </div>
            {summary.yearTime > 0 && (
              <div>
                <dt>Время чтения</dt>
                <dd>{duration(summary.yearTime)}</dd>
              </div>
            )}
            {summary.averageRating !== null && (
              <div>
                <dt>Средняя оценка</dt>
                <dd>
                  {summary.averageRating.toFixed(1)} <small>/ 5</small>
                </dd>
              </div>
            )}
            {summary.averageWpm !== null && (
              <div>
                <dt>Средняя скорость</dt>
                <dd>
                  {Math.round(summary.averageWpm)} <small>слов/мин</small>
                </dd>
              </div>
            )}
          </dl>
        </section>
      ) : (
        <section className="statistics-empty">
          <h2>Время для первой страницы</h2>
          <p className="caption">
            Выберите книгу — здесь появится ваша история чтения.
          </p>
          <a className="button button--primary" href="#/library">
            Выбрать книгу
          </a>
        </section>
      )}
      {!hasSummary && paperAction}

      {summary.yearTime > 0 && (
        <ActivityChart days={summary.days} year={year} />
      )}
      <section
        className="statistics-section statistics-goal-section"
        data-set={goal > 0}
      >
        <h2>{goal ? `Цель на ${String(year)} год` : 'Цель на год'}</h2>
        {goal > 0 && (
          <p>
            {summary.booksYear} из {goal} книг
          </p>
        )}
        {goal > 0 && (
          <progress
            aria-label="Годовая цель"
            max={goal}
            value={Math.min(goal, summary.booksYear)}
          />
        )}
        <details className="goal-editor">
          <summary aria-label={goal ? 'Изменить цель' : 'Установить цель'}>
            {goal ? 'Изменить' : 'Установить'}
          </summary>
          <form
            key={`${String(year)}-${String(goal)}`}
            className="statistics-goal"
            onSubmit={(e) => {
              e.preventDefault();
              const target = Number(new FormData(e.currentTarget).get('goal'));
              void run(async () => {
                const existing = (await store.repositories.settings.list())[0];
                const now = Math.max(
                  Date.now(),
                  (existing?.updatedAt ?? 0) + 1,
                );
                await store.repositories.settings.save(
                  {
                    ...(existing ?? {
                      id: newId(),
                      createdAt: now,
                      key: 'local' as const,
                      theme: 'system' as const,
                      locale: 'ru' as const,
                    }),
                    updatedAt: now,
                    readingGoals: { ...existing?.readingGoals, [year]: target },
                  },
                  { expectedUpdatedAt: existing?.updatedAt ?? null },
                );
              });
            }}
          >
            <TextField
              label="Книг за год"
              name="goal"
              type="number"
              min="0"
              max="1000"
              step="1"
              required
              defaultValue={goal}
              hint="0 — без цели. Повторные прочтения не увеличивают число книг."
            />
            <Button type="submit" disabled={busy}>
              Сохранить цель
            </Button>
          </form>
        </details>
      </section>
      <details className="statistics-details">
        <summary>Подробная статистика</summary>
        <div className="statistics-page">
          <section className="statistics-section">
            <h2>Итоги библиотеки</h2>
            <dl className="statistics-facts">
              <div>
                <dt>За текущий месяц</dt>
                <dd>{summary.booksMonth}</dd>
              </div>
              <div>
                <dt>За всё время</dt>
                <dd>{summary.booksAll}</dd>
              </div>
              <div>
                <dt>Средняя оценка за {year}</dt>
                <dd>
                  {summary.averageRating?.toFixed(1) ?? '—'}
                  <small> / 5</small>
                </dd>
              </div>
              <div>
                <dt>Уникальных слов за всё время</dt>
                <dd>{summary.uniqueWords.toLocaleString('ru')}</dd>
              </div>
            </dl>
          </section>

          <section className="statistics-section">
            <h2>Время с книгами</h2>
            {data.readings.length > 0 && (
              <dl className="statistics-facts">
                <div>
                  <dt>Сегодня</dt>
                  <dd>{duration(summary.dayTime)}</dd>
                </div>
                <div>
                  <dt>Эта неделя</dt>
                  <dd>{duration(summary.weekTime)}</dd>
                </div>
                <div>
                  <dt>Этот месяц</dt>
                  <dd>{duration(summary.monthTime)}</dd>
                </div>
                <div>
                  <dt>{year} год</dt>
                  <dd>{duration(summary.yearTime)}</dd>
                </div>
              </dl>
            )}
          </section>
          <section className="statistics-section">
            <h2>Ритм чтения</h2>
            <p className="caption">
              {year} · от января к декабрю, строки — понедельник–воскресенье.
            </p>
            {summary.days.size > 0 ? (
              <div
                className="activity-scroll"
                tabIndex={0}
                role="region"
                aria-label="Календарь активности; подробности доступны в списке дней"
              >
                <div className="activity-calendar" aria-hidden="true">
                  {Array.from({ length: offset }, (_, i) => (
                    <span key={`gap-${String(i)}`} />
                  ))}
                  {calendar.map((day) => {
                    const ms = summary.days.get(day) ?? 0;
                    return (
                      <span
                        key={day}
                        data-level={
                          ms === 0
                            ? 0
                            : ms < 600000
                              ? 1
                              : ms < 1800000
                                ? 2
                                : ms < 3600000
                                  ? 3
                                  : 4
                        }
                        title={`${day}: ${duration(ms)}`}
                      />
                    );
                  })}
                </div>
              </div>
            ) : (
              <p className="caption">В этом году активных сессий пока нет.</p>
            )}
            <div className="caption">
              Светлее — меньше времени · темнее — больше
            </div>
            <details>
              <summary>Дни с чтением</summary>
              <ul className="statistics-days">
                {calendar
                  .filter((d) => (summary.days.get(d) ?? 0) > 0)
                  .map((d) => (
                    <li key={d}>
                      <time dateTime={d}>{d}</time>
                      <span>{duration(summary.days.get(d) ?? 0)}</span>
                    </li>
                  ))}
              </ul>
              {!calendar.some((d) => summary.days.has(d)) && (
                <p>В этом году активных сессий пока нет.</p>
              )}
            </details>
          </section>
          <section className="statistics-section">
            <h2>Как вы читаете</h2>
            <p>
              Средняя скорость за {year}:{' '}
              {summary.averageWpm === null
                ? 'пока не определена'
                : `${String(Math.round(summary.averageWpm))} слов/мин`}
            </p>
            <div className="statistics-modes">
              {summary.modes.map((m) => (
                <article key={m.mode}>
                  <h3>{modeLabels[m.mode]}</h3>
                  <p className="statistics-number">
                    {duration(m.milliseconds)}
                  </p>
                  <p>{m.words.toLocaleString('ru')} пройденных слов</p>
                  <p className="caption">
                    {m.wpm === null
                      ? 'Скорость пока не определена'
                      : `${String(Math.round(m.wpm))} слов/мин · по активному времени`}
                  </p>
                </article>
              ))}
            </div>

            {summary.legacySeconds > 0 && (
              <p className="caption">
                Ранее сохранённое время:{' '}
                {duration(summary.legacySeconds * 1000)}. Режим и распределение
                по дням неизвестны; в календарь оно не включено.
              </p>
            )}
          </section>
          <div className="statistics-columns">
            {(['genres', 'authors'] as const).map((field) => (
              <section className="statistics-section" key={field}>
                <h2>{field === 'genres' ? 'Жанры' : 'Авторы'}</h2>
                <p className="caption">
                  Прочитанные книги за {year}. Одна книга может входить в
                  несколько групп.
                </p>
                {summary[field].length === 0 ? (
                  <p className="caption">Пока нет данных.</p>
                ) : (
                  <ul className="statistics-bars">
                    {summary[field].map(([label, count]) => (
                      <li key={label}>
                        <div>
                          <span>{label}</span>
                          <strong>{count}</strong>
                        </div>
                        <meter
                          min={0}
                          max={summary.booksYear || 1}
                          value={count}
                          aria-label={`${label}: ${String(count)}`}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
        </div>
      </details>
      {(data.readings.length > 0 || data.journal.length > 0) && (
        <details
          className="statistics-details statistics-history"
          open={hasSummary || data.journal.length > 0}
        >
          <summary>История и дневник</summary>
          <div className="statistics-page">
            {current.length > 0 && (
              <section className="statistics-section">
                <h2>Сейчас с вами</h2>
                {current.length === 0 && (
                  <p className="caption">Здесь появятся текущие прочтения.</p>
                )}
                {current.map((r) => {
                  const position = data.positions
                    .filter((p) => p.readingId === r.id)
                    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
                  return (
                    <article className="statistics-reading" key={r.id}>
                      <h3>{bookTitle(r.bookId)}</h3>
                      <p className="caption">
                        {statusLabels[r.status]} · позиция{' '}
                        {position
                          ? `${String(Math.round(position.progression * 100))}%`
                          : 'не сохранена'}
                      </p>
                      {position && (
                        <progress
                          aria-label={`Позиция: ${bookTitle(r.bookId)}`}
                          max={1}
                          value={position.progression}
                        />
                      )}
                      <p className="caption">
                        Позиция в тексте, не доля подтверждённых прочитанных
                        слов.
                      </p>
                    </article>
                  );
                })}
              </section>
            )}
            {summary.yearly.length > 0 && (
              <section className="statistics-section">
                <h2>Прочитано в {year}</h2>
                {summary.yearly.length === 0 ? (
                  <p className="caption">
                    Завершённых прочтений пока нет. Бумажную книгу тоже можно
                    добавить и указать дату.
                  </p>
                ) : (
                  summary.yearly
                    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
                    .map((r) => (
                      <article className="statistics-reading" key={r.id}>
                        <h3>{bookTitle(r.bookId)}</h3>
                        <p>
                          {dateInput(r.finishedAt)} ·{' '}
                          {r.rating === null
                            ? 'Без оценки'
                            : `${String(r.rating)} / 5`}
                        </p>
                        {r.review && (
                          <p className="statistics-prose">{r.review}</p>
                        )}
                        <Button
                          variant="quiet"
                          onClick={() => {
                            setReading(r);
                          }}
                        >
                          Изменить прочтение
                        </Button>
                      </article>
                    ))
                )}
              </section>
            )}
            {data.readings.length > 0 && (
              <section className="statistics-section">
                <h2>История прочтений</h2>
                {data.readings.length === 0 && (
                  <p className="caption">Добавьте первую книгу в библиотеку.</p>
                )}
                {[...data.readings]
                  .sort((a, b) => b.createdAt - a.createdAt)
                  .map((r) => {
                    const events = data.activities.filter(
                      (a) => a.readingId === r.id,
                    );
                    const groups = new Map<string, typeof events>();
                    for (const event of events) {
                      const key = `${event.contentId}:${String(event.textVersion)}`;
                      const group = groups.get(key) ?? [];
                      group.push(event);
                      groups.set(key, group);
                    }
                    const unique = [...groups.values()].reduce(
                      (n, es) =>
                        n + intervalWords(es.flatMap((e) => e.intervals)),
                      0,
                    );
                    return (
                      <details className="statistics-reading" key={r.id}>
                        <summary>
                          {bookTitle(r.bookId)} · {statusLabels[r.status]}
                        </summary>
                        <p>
                          {dateInput(r.startedAt) || 'Начало не указано'} —{' '}
                          {dateInput(r.finishedAt) || 'не завершено'}
                        </p>
                        <p>
                          {r.rating === null
                            ? 'Без оценки'
                            : `Оценка ${String(r.rating)} / 5`}
                        </p>
                        {r.review && (
                          <p className="statistics-prose">{r.review}</p>
                        )}
                        <p>
                          {unique.toLocaleString('ru')} уникальных слов в этом
                          прочтении
                        </p>
                        {(['ordinary', 'rsvp', 'guided'] as const).map((m) => (
                          <p className="caption" key={m}>
                            {modeLabels[m]}:{' '}
                            {duration(
                              events
                                .filter((e) => e.mode === m)
                                .reduce((n, e) => n + e.milliseconds, 0),
                            )}
                          </p>
                        ))}
                        <div className="statistics-actions">
                          <Button
                            variant="quiet"
                            onClick={() => {
                              setReading(r);
                            }}
                          >
                            Изменить прочтение
                          </Button>
                          <Button
                            variant="quiet"
                            disabled={busy}
                            onClick={() => {
                              void run(async () => {
                                setReading(await store.addReading(r.bookId));
                              });
                            }}
                          >
                            Новое прочтение
                          </Button>
                        </div>
                      </details>
                    );
                  })}
              </section>
            )}
            <section className="statistics-section">
              <div className="statistics-toolbar">
                <h2>Книжный дневник</h2>
                <Button
                  variant="secondary"
                  disabled={data.readings.length === 0}
                  onClick={() => {
                    setEntry('new');
                  }}
                >
                  Записать впечатление
                </Button>
              </div>
              {data.journal.length === 0 && (
                <p className="caption">
                  Сохраняйте мысли и впечатления по ходу чтения. Записи доступны
                  и без файла книги.
                </p>
              )}
              {[...data.journal]
                .sort(
                  (a, b) =>
                    b.day.localeCompare(a.day) || b.createdAt - a.createdAt,
                )
                .map((item) => (
                  <article key={item.id} className="statistics-reading">
                    <time dateTime={item.day} className="caption">
                      {item.day}
                    </time>
                    <h3>{bookTitle(item.bookId)}</h3>
                    <p className="statistics-prose">{item.body}</p>
                    <div className="statistics-actions">
                      <Button
                        variant="quiet"
                        onClick={() => {
                          setEntry(item);
                        }}
                      >
                        Редактировать запись
                      </Button>
                      <Button
                        variant="quiet"
                        onClick={() => {
                          setRemove(item);
                        }}
                      >
                        Удалить запись
                      </Button>
                    </div>
                  </article>
                ))}
            </section>
          </div>
        </details>
      )}
      <details className="statistics-help">
        <summary>Как считаются показатели</summary>
        <div className="form-stack">
          <p>
            Активное время не включает фон и паузы. Неделя начинается в
            понедельник. Часовой пояс: {zone}.
          </p>{' '}
          <p className="caption">
            В обычном режиме слова учитываются по кнопке «Фрагмент прочитан»
            после времени на чтение. В RSVP и Guided — после показа слова.
            Переходы и пропуски не засчитываются. Скорость учитывает повторные
            проходы; уникальный объём — объединение интервалов одного
            содержимого без повторов.
          </p>
        </div>
      </details>
      {hasSummary && paperAction}
      {paper && (
        <BookEditor
          book={undefined}
          store={store}
          onClose={() => {
            setPaper(false);
          }}
          onOpenDuplicate={() => {
            setPaper(false);
            void refresh();
          }}
          onSaved={async (id) => {
            await refresh();
            const readings = await store.repositories.readings.list();
            const initial = readings.find((r) => r.bookId === id);
            setPaper(false);
            if (initial) setReading(initial);
          }}
        />
      )}
      {reading && (
        <ReadingEditor
          reading={reading}
          store={store}
          onClose={() => {
            setReading(null);
          }}
          onSaved={async () => {
            setReading(null);
            await refresh();
          }}
        />
      )}
      {entry && (
        <JournalEditor
          store={store}
          entry={entry === 'new' ? null : entry}
          data={data}
          zone={zone}
          onClose={() => {
            setEntry(null);
          }}
          onSaved={async () => {
            setEntry(null);
            await refresh();
          }}
        />
      )}
      {remove && (
        <Dialog
          open
          title="Удалить запись дневника?"
          onClose={() => {
            if (!busy) setRemove(null);
          }}
        >
          <p>
            Будет удалено это впечатление. История прочтения, оценка и книга
            сохранятся.
          </p>
          {error && <p role="alert">{error}</p>}
          <div className="statistics-actions">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setRemove(null);
              }}
            >
              Отмена
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                void run(async () => {
                  await store.removeJournal(remove.id, remove.updatedAt);
                  setRemove(null);
                });
              }}
            >
              Удалить запись
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function JournalEditor({
  store,
  entry,
  data,
  zone,
  onClose,
  onSaved,
}: {
  store: LocalStore;
  entry: JournalEntry | null;
  data: StatisticsSnapshot;
  zone: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [readingId, setReadingId] = useState(
    entry?.readingId ?? data.readings[0]?.id ?? '',
  );
  const [defaultDay] = useState(() => localDay(Date.now(), zone));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  return (
    <EditorDialog
      title={entry ? 'Редактировать впечатление' : 'Новое впечатление'}
      dirty={dirty}
      busy={busy}
      onClose={onClose}
    >
      <form
        className="form-stack"
        onChange={() => {
          setDirty(true);
        }}
        onSubmit={(e) => {
          e.preventDefault();
          if (lock.current) return;
          const values = new FormData(e.currentTarget),
            reading = data.readings.find((r) => r.id === readingId);
          const text = (name: string) => {
            const value = values.get(name);
            return typeof value === 'string' ? value : '';
          };
          if (!reading) return;
          const now = Math.max(Date.now(), (entry?.updatedAt ?? 0) + 1);
          const item: JournalEntry = {
            id: entry?.id ?? newId(),
            createdAt: entry?.createdAt ?? now,
            updatedAt: now,
            readingId: reading.id,
            bookId: reading.bookId,
            day: text('day'),
            body: text('body').trim(),
          };
          lock.current = true;
          setBusy(true);
          setError(null);
          void store.repositories.journal
            .save(item, { expectedUpdatedAt: entry?.updatedAt ?? null })
            .then(onSaved)
            .catch((reason: unknown) => {
              setError(
                reason instanceof Error
                  ? reason.message
                  : 'Не удалось сохранить запись.',
              );
            })
            .finally(() => {
              lock.current = false;
              setBusy(false);
            });
        }}
      >
        <SelectField
          label="Прочтение"
          value={readingId}
          disabled={Boolean(entry)}
          onChange={(e) => {
            setReadingId(e.target.value);
          }}
        >
          {data.readings.map((r) => (
            <option key={r.id} value={r.id}>
              {data.books.find((b) => b.id === r.bookId)?.title} ·{' '}
              {statusLabels[r.status]} ·{' '}
              {dateInput(r.startedAt) ||
                new Date(r.createdAt).toLocaleDateString('ru')}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Дата записи"
          name="day"
          type="date"
          required
          defaultValue={entry?.day ?? defaultDay}
        />
        <TextArea
          label="Впечатление"
          name="body"
          required
          maxLength={20000}
          defaultValue={entry?.body ?? ''}
        />
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy}>
          Сохранить запись
        </Button>
      </form>
    </EditorDialog>
  );
}
