import { useState } from 'react';
import type { ReaderSearchMatch } from '../../domain/reader';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
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
  return (
    <div className="reader-search-results">
      <ol>
        {matches
          .slice(0, limit)
          .map(({ chapter, text, spineIndex, start, end }, index) => {
            const from = Math.max(0, start - 38);
            const to = Math.min(text.length, end + 38);
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
                    {text.slice(from, start)}
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
      <label className="field">
        <span className="visually-hidden">Слово или фраза</span>
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
