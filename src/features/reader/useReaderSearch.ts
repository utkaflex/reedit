import { useEffect, useState } from 'react';
import type { ReaderSearchMatch, ReaderSession } from '../../domain/reader';

export function useReaderSearch(reader: ReaderSession | null) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<{
    query: string;
    reader: ReaderSession;
    matches: ReaderSearchMatch[];
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (!reader || !query.trim()) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void reader.searchText(query, abort.signal).then(
        (matches) => {
          if (!abort.signal.aborted) setResult({ query, reader, matches });
        },
        () => {
          if (!abort.signal.aborted)
            setResult({
              query,
              reader,
              matches: [],
              error: 'Не удалось найти текст. Попробуйте ещё раз.',
            });
        },
      );
    }, 180);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query, reader]);
  const current =
    result?.query === query && result.reader === reader ? result : null;
  return {
    query,
    setQuery,
    matches: current?.matches ?? [],
    error: current?.error,
    pending: Boolean(query.trim() && !current),
  };
}
