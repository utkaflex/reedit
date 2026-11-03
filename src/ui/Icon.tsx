import type { ReactNode } from 'react';

const shapes = {
  play: <path d="m9 5 11 7-11 7V5Z" />,
  pause: <path d="M8 5v14M16 5v14" />,
  repeat: <path d="M5 8h10a6 6 0 1 1-5.5 8M5 8l4-4M5 8l4 4" />,
  contents: <path d="M8 6h12M8 12h12M8 18h12M3 6h.01M3 12h.01M3 18h.01" />,
  quote: <path d="M10 5H4v7h5c0 4-2 6-5 7M21 5h-6v7h5c0 4-2 6-5 7" />,
  bookmark: <path d="M6 3h12v18l-6-4-6 4V3Z" />,
  library: (
    <>
      <path d="M4 4h4v16H4zM11 4h4v16h-4zM17 5l3-1 3 15-3 1z" />
    </>
  ),
  chart: (
    <>
      <path d="M5 20V12M12 20V4M19 20V8" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h16M4 17h16" />
      <circle cx="9" cy="7" r="3" />
      <circle cx="15" cy="17" r="3" />
    </>
  ),
  book: (
    <>
      <path d="M12 5c-3-2-6-2-10-1v15c4-1 7-1 10 1 3-2 6-2 10-1V4c-4-1-7-1-10 1ZM12 5v15" />
    </>
  ),
  arrow: <path d="m9 5 7 7-7 7" />,
  back: <path d="m15 5-7 7 7 7" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  check: <path d="m5 12 4 4L19 6" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7h.01" />
    </>
  ),
  alert: (
    <>
      <path d="m12 3 10 18H2L12 3Z" />
      <path d="M12 9v5M12 17h.01" />
    </>
  ),
  device: (
    <>
      <rect x="6" y="2" width="12" height="20" rx="3" />
      <path d="M10 18h4" />
    </>
  ),
} satisfies Record<string, ReactNode>;
export type IconName = keyof typeof shapes;
/** One original outline family. Decorative; the enclosing control supplies its name. */
export function Icon({
  name,
  className = '',
}: {
  name: IconName;
  className?: string;
}) {
  return (
    <svg
      className={`icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {shapes[name]}
    </svg>
  );
}
