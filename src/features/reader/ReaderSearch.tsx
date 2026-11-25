import { useEffect, useRef, useState } from 'react';
import type { ReaderSearchMatch } from '../../domain/reader';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import type { useReaderSearch } from './useReaderSearch';

const batch = 30;

function SearchResults({
  matches,
  active,
  busy,
  onNavigate,
}: {
  matches: ReaderSearchMatch[];
  active?: number | undefined;
  busy: boolean;
  onNavigate: (number: number) => void;
}) {
  const [limit, setLimit] = useState(Math.max(batch, (active ?? 0) + 1));
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const container = list.current;
      const current = container?.querySelector('[aria-current="location"]');
      if (!container || !current) return;
      const view = container.getBoundingClientRect();
      const row = current.getBoundingClientRect();
      if (row.top < view.top) container.scrollTop += row.top - view.top;
      else if (row.bottom > view.bottom)
        container.scrollTop += row.bottom - view.bottom;
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [active]);
  return (
    <div ref={list} className="reader-search-results">
      <ol>
        {matches
          .slice(0, limit)
          .map(({ chapter, text, spineIndex, start, end }, index) => {
            const from = Math.max(0, start - 38);
            const to = Math.min(text.length, end + 38);
            const context = text.slice(from, start);
            const before =
              from === 0 && context.startsWith(chapter + ' ')
                ? context.slice(chapter.length + 1)
                : context;
            return (
              <li key={String(spineIndex) + ':' + String(start)}>
                <Button
                  variant="quiet"
                  disabled={busy}
                  aria-current={active === index ? 'location' : undefined}
                  onClick={() => {
                    onNavigate(index);
                  }}
                >
                  <span className="reader-search-chapter">{chapter}</span>
                  <span>
                    {from > 0 && '…'}
                    {before}
                    <mark>{text.slice(start, end)}</mark>
                    {text.slice(end, to)}
                    {to < text.length && '…'}
                  </span>
                </Button>
              </li>
            );
          })}
      </ol>
      {limit < matches.length && (
        <Button
          variant="quiet"
          onClick={() => {
            setLimit((value) => value + batch);
          }}
        >
          Показать ещё
        </Button>
      )}
    </div>
  );
}

export function ReaderSearch({
  search,
  active,
  busy,
  onClose,
  onNavigate,
}: {
  search: ReturnType<typeof useReaderSearch>;
  active?: number | undefined;
  busy: boolean;
  onClose: () => void;
  onNavigate: (number: number) => void;
}) {
  const { query, setQuery, matches, pending, error } = search;
  return (
    <Dialog
      open
      presentation="panel"
      title="Поиск по книге"
      className="reader-search"
      onClose={onClose}
    >
      <label className="field reader-search-field">
        <span className="visually-hidden">Слово или фраза</span>
        <Icon name="search" />
        <input
          type="search"
          enterKeyHint="search"
          value={query}
          placeholder="Слово или фраза"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
      </label>
      {query.trim() && (
        <p className="reader-search-status" role="status">
          {pending
            ? 'Ищем по книге…'
            : (error ??
              (matches.length
                ? 'Совпадений: ' + String(matches.length)
                : 'Ничего не найдено.'))}
        </p>
      )}
      {matches.length > 0 && (
        <SearchResults
          key={query}
          matches={matches}
          active={active}
          busy={busy}
          onNavigate={onNavigate}
        />
      )}
    </Dialog>
  );
}
