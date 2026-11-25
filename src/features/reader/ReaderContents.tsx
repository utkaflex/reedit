import type { EpubIndex } from '../../domain/model';
import type { EpubNavItem } from '../../domain/epub';
import { flattenNavigation, type ReaderTarget } from '../../domain/reader';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';

const frontLabels = new Map([
  ['annotation', 'Аннотация'],
  ['abstract', 'Аннотация'],
  ['аннотация', 'Аннотация'],
  ['cover', 'Обложка'],
  ['обложка', 'Обложка'],
  ['title page', 'Титульный лист'],
  ['титульный лист', 'Титульный лист'],
  ['dedication', 'Посвящение'],
  ['посвящение', 'Посвящение'],
  ['epigraph', 'Эпиграф'],
  ['эпиграф', 'Эпиграф'],
  ['preface', 'Предисловие'],
  ['foreword', 'Предисловие'],
  ['предисловие', 'Предисловие'],
]);
const normalizedLabel = (label: string) =>
  label.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ru');
const isNotes = (item: EpubNavItem) =>
  /^(примечания|сноски|footnotes|endnotes|notes)$/iu.test(item.label.trim());

export function ReaderContents({
  index,
  currentPath,
  currentChapter,
  onKeepPlace,
  onClose,
  onNavigate,
}: {
  index: EpubIndex;
  currentPath?: string | undefined;
  currentChapter?: string | undefined;
  onKeepPlace?: () => void;
  onClose: () => void;
  onNavigate: (target: ReaderTarget) => void;
}) {
  const introduction: EpubNavItem[] = [];
  const chapters: EpubNavItem[] = [];
  const notes: EpubNavItem[] = [];
  const titleLabels = [
    index.metadata.title,
    [...index.metadata.authors, index.metadata.title].join(' '),
  ].map(normalizedLabel);
  let inNotes = false;
  for (const item of index.navigation) {
    inNotes = isNotes(item) || (inNotes && /^\d+$/u.test(item.label.trim()));
    const label = normalizedLabel(item.label);
    if (inNotes) notes.push(item);
    else if (frontLabels.has(label) || (label && titleLabels.includes(label)))
      introduction.push(item);
    else chapters.push(item);
  }
  const navigation = flattenNavigation(index.navigation);
  const extraSections = index.sections.filter(
    (section) =>
      !navigation.some(
        (item) => item.path === section.path && item.label.trim(),
      ),
  );
  const samePath = navigation.filter((item) => item.path === currentPath);
  const current =
    samePath.find((item) => item.label === currentChapter) ??
    samePath.find((item) => !item.fragment) ??
    samePath[0];
  const list = (items: EpubNavItem[], groupNotes = true) => {
    const rows = [];
    let lastGroupedIndex = -1;
    for (const [number, item] of items.entries()) {
      if (number <= lastGroupedIndex) continue;
      const notes = groupNotes && isNotes(item);
      const key = `${item.path}#${item.fragment}-${String(number)}`;
      if (notes) {
        const numbered: EpubNavItem[] = [];
        for (const next of items.slice(number + 1)) {
          if (!/^\d+$/u.test(next.label.trim())) break;
          numbered.push(next);
        }
        lastGroupedIndex = number + numbered.length;
        rows.push(
          <li key={key}>
            <details className="reader-toc-notes">
              <summary>Примечания</summary>
              <Button
                variant="quiet"
                onClick={() => {
                  onNavigate(item);
                }}
              >
                К разделу примечаний
              </Button>
              {list([...item.children, ...numbered], false)}
            </details>
          </li>,
        );
      } else {
        rows.push(
          <li key={key}>
            <Button
              variant="quiet"
              aria-current={item === current ? 'location' : undefined}
              onClick={() => {
                onNavigate(item);
              }}
            >
              {frontLabels.get(normalizedLabel(item.label)) ??
                (item.label || 'Без названия')}
            </Button>
            {item.children.length > 0 && list(item.children)}
          </li>,
        );
      }
    }
    return <ol className="reader-toc">{rows}</ol>;
  };
  return (
    <Dialog
      open
      presentation="panel"
      title="Оглавление"
      onClose={onClose}
      footer={
        onKeepPlace && <Button onClick={onKeepPlace}>Читать отсюда</Button>
      }
    >
      {introduction.length > 0 && (
        <section
          className="reader-toc-group"
          aria-label="Вступительные материалы"
        >
          <h3>Вступительные материалы</h3>
          {list(introduction)}
        </section>
      )}
      {chapters.length > 0 && (
        <section className="reader-toc-group" aria-label="Главы">
          {(introduction.length > 0 || notes.length > 0) && <h3>Главы</h3>}
          {list(chapters)}
        </section>
      )}
      {notes.length > 0 && (
        <div className="reader-toc-group">{list(notes)}</div>
      )}
      {extraSections.length > 0 && (
        <details className="reader-all-sections" open={navigation.length === 0}>
          <summary>Разделы вне оглавления ({extraSections.length})</summary>
          <ol className="reader-toc">
            {extraSections.map((section) => (
              <li key={`${String(section.spineIndex)}-${section.path}`}>
                <Button
                  variant="quiet"
                  onClick={() => {
                    onNavigate({ path: section.path });
                  }}
                >
                  Раздел {section.spineIndex + 1} ·{' '}
                  {section.path.split('/').at(-1)}
                </Button>
              </li>
            ))}
          </ol>
        </details>
      )}
    </Dialog>
  );
}
