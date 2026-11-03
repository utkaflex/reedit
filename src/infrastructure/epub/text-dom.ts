const prepared = new WeakSet<Document>();
/** Canonical inert display DOM only; original EPUB bytes are never changed. */
export function prepareTextDocument(doc: Document): void {
  if (prepared.has(doc)) return;
  const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_CDATA_SECTION);
  const sections: Node[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    sections.push(node);
  for (const node of sections)
    node.parentNode?.replaceChild(
      doc.createTextNode(node.textContent ?? ''),
      node,
    );
  doc.normalize();
  prepared.add(doc);
}
