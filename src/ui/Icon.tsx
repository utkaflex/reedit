import type { ReactNode } from 'react';

const shapes = {
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  upload: <path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" />,
  search: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="m15 15 6 6" />
    </>
  ),
  hide: <path d="M4 5h16M4 19h16m-12-5 4-4 4 4" />,
  play: <path d="m9 5 11 7-11 7V5Z" />,
  pause: <path d="M8 5v14M16 5v14" />,
  repeat: <path d="M5 8h10a6 6 0 1 1-5.5 8M5 8l4-4M5 8l4 4" />,
  contents: <path d="M8 6h12M8 12h12M8 18h12M3 6h.01M3 12h.01M3 18h.01" />,
  quote: (
    <path
      d="M9.5 7C6 8 4 10.7 4 14v3h6v-6H7.1c.4-1.4 1.3-2.5 2.4-3.2ZM19.5 7C16 8 14 10.7 14 14v3h6v-6h-2.9c.4-1.4 1.3-2.5 2.4-3.2Z"
      fill="currentColor"
      stroke="none"
    />
  ),
  bookmark: <path d="M6 3h12v18l-6-4-6 4V3Z" />,
  library: (
    <>
      <path d="M3 5h4v14H3zM10 5h4v14h-4zM17 6l3-1 2 13-3 1z" />
    </>
  ),
  chart: (
    <>
      <path d="M5 20V12M12 20V4M19 20V8" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="6.5" />
      <circle cx="12" cy="12" r="2.4" />
      <path d="M12 2.5v3m0 13v3M2.5 12h3m13 0h3M5.3 5.3l2.1 2.1m9.2 9.2 2.1 2.1m0-13.4-2.1 2.1m-9.2 9.2-2.1 2.1" />
    </>
  ),
  filter: (
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
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  back: <path d="M20 12H4m6-6-6 6 6 6" />,
  previous: <path d="m14 6-6 6 6 6" />,
  next: <path d="m10 6 6 6-6 6" />,
  expand: <path d="m6 9 6 6 6-6" />,
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
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {shapes[name]}
    </svg>
  );
}
