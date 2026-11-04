import { useState } from 'react';
/** A stable, local visual fallback. No generated user content or network request. */
export function BookCover({
  title,
  authors,
  url,
}: {
  title: string;
  authors: readonly string[];
  url?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const tone =
    Array.from(title).reduce(
      (sum, char) => sum + (char.codePointAt(0) ?? 0),
      0,
    ) % 3;
  return (
    <span className="book-card__cover" data-tone={tone} aria-hidden="true">
      {url && url !== failed ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          onError={() => {
            setFailed(url);
          }}
        />
      ) : (
        <span className="book-card__fallback">
          <span className="cover-edition">Личная библиотека</span>
          <span>{title}</span>
          <small>{authors.join(', ') || 'Автор не указан'}</small>
        </span>
      )}
    </span>
  );
}
