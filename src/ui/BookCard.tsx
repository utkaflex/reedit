import { BookCover } from './BookCover';
export interface BookCardProps {
  title: string;
  authors: readonly string[];
  coverUrl?: string;
  onOpen: () => void;
}
/** Presentational only. Never creates or fetches books. */
export function BookCard({ title, authors, coverUrl, onOpen }: BookCardProps) {
  return (
    <button type="button" className="book-card" onClick={onOpen}>
      <BookCover title={title} {...(coverUrl ? { url: coverUrl } : {})} />
      <span className="book-card__title" title={title}>
        {title}
      </span>
      {authors.length > 0 && (
        <span className="book-card__authors" title={authors.join(', ')}>
          {authors.join(', ')}
        </span>
      )}
    </button>
  );
}
