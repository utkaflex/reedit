import { useState } from 'react';
import { Icon } from './Icon';
export interface BookCardProps {
  title: string;
  authors: readonly string[];
  coverUrl?: string;
  onOpen: () => void;
}
/** Presentational only. Never creates or fetches books. */
export function BookCard({ title, authors, coverUrl, onOpen }: BookCardProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <button type="button" className="book-card" onClick={onOpen}>
      <span className="book-card__cover" aria-hidden="true">
        {coverUrl && coverUrl !== failedUrl ? (
          <img
            src={coverUrl}
            alt=""
            loading="lazy"
            onError={() => {
              setFailedUrl(coverUrl);
            }}
          />
        ) : (
          <span className="book-card__fallback">
            <Icon name="book" />
            <span>{title}</span>
          </span>
        )}
      </span>
      <span className="book-card__title">{title}</span>
      {authors.length > 0 && (
        <span className="book-card__authors">{authors.join(', ')}</span>
      )}
    </button>
  );
}
