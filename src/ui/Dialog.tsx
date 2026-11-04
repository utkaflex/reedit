import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
export interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  presentation?: 'dialog' | 'panel';
  className?: string;
  footer?: ReactNode;
}
export function Dialog({
  open,
  title,
  onClose,
  children,
  presentation = 'dialog',
  className = '',
  footer,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = ref.current;
    if (!open || !element) return;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    element.showModal();
    document.body.style.overflow = 'hidden';
    const viewport = window.visualViewport;
    const fitKeyboard = () => {
      if (!viewport) return;
      element.style.maxHeight = `max(120px, calc(${String(viewport.height)}px - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 32px))`;
      if (presentation === 'panel') {
        element.style.top = `${String(viewport.offsetTop + viewport.height)}px`;
        element.style.bottom = 'auto';
        element.style.marginBlock = '0';
        element.style.translate = '0 -100%';
        return;
      }
      element.style.top = `${String(viewport.offsetTop + viewport.height / 2)}px`;
      element.style.bottom = 'auto';
      element.style.marginBlock = '0';
      element.style.translate = '0 -50%';
    };
    fitKeyboard();
    viewport?.addEventListener('resize', fitKeyboard);
    viewport?.addEventListener('scroll', fitKeyboard);
    return () => {
      viewport?.removeEventListener('resize', fitKeyboard);
      viewport?.removeEventListener('scroll', fitKeyboard);
      element.close();
      window.dispatchEvent(new Event('reedit:dialog-closed'));
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus({ preventScroll: true });
    };
  }, [open, presentation]);
  return (
    <dialog
      ref={ref}
      className={`dialog dialog--${presentation} ${className} ${footer ? 'dialog--with-footer' : ''}`}
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const element = event.currentTarget;
        const controls = [
          ...element.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]',
          ),
        ].filter(
          (control) =>
            control.tabIndex >= 0 &&
            !control.matches(':disabled') &&
            control.getClientRects().length > 0,
        );
        const first = controls[0];
        const last = controls.at(-1);
        if (!first || !last) {
          event.preventDefault();
          element.focus();
          return;
        }
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === element)
        ) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="dialog__header">
        <h2 id={titleId}>{title}</h2>
        <Button
          variant="quiet"
          className="icon-button"
          aria-label="Закрыть"
          onClick={onClose}
        >
          <Icon name="close" />
        </Button>
      </header>
      <div className="dialog__body">{children}</div>
      {footer && <footer className="dialog__footer">{footer}</footer>}
    </dialog>
  );
}
export function Panel(props: Omit<DialogProps, 'presentation'>) {
  return <Dialog {...props} presentation="panel" />;
}
