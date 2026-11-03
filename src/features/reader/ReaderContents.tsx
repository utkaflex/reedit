import type { EpubIndex } from '../../domain/model';
import type { EpubNavItem } from '../../domain/epub';
import type { ReaderTarget } from '../../domain/reader';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
export function ReaderContents({
  index,
  onClose,
  onNavigate,
}: {
  index: EpubIndex;
  onClose: () => void;
  onNavigate: (target: ReaderTarget) => void;
}) {
  const list = (items: EpubNavItem[]) => (
    <ol className="reader-toc">
      {items.map((item, number) => (
        <li key={`${item.path}#${item.fragment}-${String(number)}`}>
          <Button
            variant="quiet"
            onClick={() => {
              onNavigate(item);
            }}
          >
            {item.label || 'Без названия'}
          </Button>
          {item.children.length > 0 && list(item.children)}
        </li>
      ))}
    </ol>
  );
  return (
    <Dialog open title="Оглавление" onClose={onClose}>
      {list(index.navigation)}
      <details className="reader-all-sections">
        <summary>Все текстовые разделы ({index.sections.length})</summary>
        <ol className="reader-toc">
          {index.sections.map((section, number) => (
            <li key={`${String(section.spineIndex)}-${section.path}`}>
              <Button
                variant="quiet"
                onClick={() => {
                  onNavigate({ path: section.path });
                }}
              >
                Раздел {number + 1} · {section.path.split('/').at(-1)}
              </Button>
            </li>
          ))}
        </ol>
      </details>
    </Dialog>
  );
}
