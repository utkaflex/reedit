import { resolveReference } from './xml';

const semanticSelector = '[role="doc-footnote"],[role="doc-endnote"]';
const numberedMarker = /^(?:\[\d+\]|\d+)$/u;
const noteId = /^(?:fn|footnote|endnote|note)[-_.:]?\d+$/iu;

export function epubTypes(element: Element): string[] {
  return (
    element.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ??
    element.getAttribute('epub:type') ??
    ''
  ).split(/\s+/u);
}

export function explicitNoteLink(anchor: Element): boolean {
  return (
    anchor.getAttribute('role') === 'doc-noteref' ||
    epubTypes(anchor).includes('noteref')
  );
}

export function numberLink(anchor: Element): boolean {
  return numberedMarker.test(anchor.textContent.trim());
}

export function missingLegacyNote(anchor: Element, fragment: string): boolean {
  const label = anchor.textContent.trim();
  return (
    noteId.test(fragment) &&
    (label.startsWith('[') ||
      Boolean(anchor.closest('sup') ?? anchor.querySelector('sup')))
  );
}

export function noteDestination(
  doc: Document,
  fragment: string,
): Element | null {
  return (
    doc.getElementById(fragment) ??
    Array.from(doc.getElementsByTagNameNS('*', 'a')).find(
      (anchor) => anchor.getAttribute('name') === fragment,
    ) ??
    null
  );
}

export function semanticNote(target: Element): Element | null {
  for (let node: Element | null = target; node; node = node.parentElement) {
    if (
      node.matches(semanticSelector) ||
      epubTypes(node).some((type) =>
        ['footnote', 'endnote', 'rearnote'].includes(type),
      )
    )
      return node;
  }
  return null;
}

function* headingBody(heading: Element): Generator<Element> {
  for (
    let next = heading.nextElementSibling;
    next;
    next = next.nextElementSibling
  ) {
    if (/^h[1-6]$/u.test(next.localName) && next.localName <= heading.localName)
      break;
    yield next;
  }
}

export function reciprocalNote(
  anchor: Element,
  target: Element,
  path: string,
): Element | null {
  if (!numberLink(anchor)) return null;
  const label = anchor.textContent.trim();
  if (
    !label.startsWith('[') &&
    !anchor.closest('sup') &&
    !anchor.querySelector('sup') &&
    !noteId.test(target.id)
  )
    return null;
  const heading = /^h[1-6]$/u.test(target.localName);
  const block = heading
    ? target
    : (target.closest('p,li,dd,aside,blockquote') ??
      (target.localName === 'a' ? target.nextElementSibling : null) ??
      target.closest('div,section') ??
      target);
  if (block.contains(anchor) || block.matches('html,body,main')) return null;
  const adjacent = (anchor.closest('sup') ?? anchor).previousElementSibling;
  const sourceIds = [
    anchor,
    anchor.closest('sup'),
    anchor.closest('p,li,dd'),
    adjacent?.matches('a:not([href])') ? adjacent : null,
  ]
    .flatMap((node) => (node ? [node.id, node.getAttribute('name') ?? ''] : []))
    .filter(Boolean);
  if (!sourceIds.length) return null;
  const returns = [block, ...(heading ? headingBody(block) : [])].some(
    (element) =>
      Array.from(element.querySelectorAll('a[href]')).some((back) => {
        try {
          const ref = resolveReference(path, back.getAttribute('href') ?? '');
          return ref.path === path && sourceIds.includes(ref.fragment);
        } catch {
          return false;
        }
      }),
  );
  return returns ? block : null;
}

export function noteText(note: Element, target: Element): string {
  const doc = note.ownerDocument;
  const body = doc.createElement('div');
  if (note === target && /^h[1-6]$/u.test(target.localName)) {
    for (const next of headingBody(target)) {
      body.append(next.cloneNode(true));
    }
  }
  if (!body.textContent.trim()) body.append(note.cloneNode(true));
  for (const node of body.querySelectorAll('a[role="doc-backlink"]'))
    node.remove();
  for (const node of body.querySelectorAll('p,li,h1,h2,h3,h4,h5,h6,br'))
    node.after(doc.createTextNode('\n'));
  return body.textContent.trim();
}
