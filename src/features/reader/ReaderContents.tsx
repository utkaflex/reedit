import type { EpubIndex } from '../../domain/model';
import type { EpubNavItem } from '../../domain/epub';
import { flattenNavigation, type ReaderTarget } from '../../domain/reader';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
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
  const isNotes = (item: EpubNavItem) =>
    /^(примечания|сноски|footnotes|endnotes|notes)(?:\s|$)/iu.test(
      item.label.trim(),
    );
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
              {item.label || 'Без названия'}
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
      {list(index.navigation)}
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
