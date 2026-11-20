import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

function TypographicCover({ title }: { title: string }) {
  const sample = useRef<HTMLSpanElement>(null);
  const [fits, setFits] = useState(false);
  useEffect(() => {
    const element = sample.current;
    if (!element) return;
    let active = true;
    const measure = () => {
      if (active)
        setFits(
          element.scrollWidth <= element.clientWidth &&
            element.scrollHeight <= element.clientHeight,
        );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    void document.fonts.ready.then(measure);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [title]);
  return (
    <>
      <span className="cover-title-sample" ref={sample}>
        {title}
      </span>
      {fits ? (
        <span className="cover-short-title">{title}</span>
      ) : (
        <span className="cover-initial">
          {Array.from(title.trim())[0]?.toLocaleUpperCase('ru')}
        </span>
      )}
    </>
  );
}
/** A stable, local visual fallback. No generated user content or network request. */
export function BookCover({
  title,
  url,
  compact = false,
}: {
  title: string;
  url?: string;
  compact?: boolean;
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
          {compact ? <Icon name="book" /> : <TypographicCover title={title} />}
        </span>
      )}
    </span>
  );
}
