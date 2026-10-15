import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * A modal dialog built on the native <dialog> element, which handles focus
 * trapping, Escape and the backdrop. It opens when mounted: render it
 * conditionally and unmount it in `onClose`. Mark the element that should get
 * focus with `data-autofocus` (React's autoFocus runs before showModal()
 * moves focus to the first focusable element).
 */
export function Modal({
  title,
  onClose,
  busy = false,
  wide = false,
  children,
}: {
  title: string;
  onClose: () => void;
  /** While true, Escape and backdrop clicks are ignored. */
  busy?: boolean;
  /** A wider dialog, for showing code or JSON. */
  wide?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || dialog.open) {
      return;
    }
    dialog.showModal();
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, []);

  return (
    <dialog
      ref={ref}
      className={wide ? 'modal wide' : 'modal'}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) {
          onClose();
        }
      }}
      onClick={(e) => {
        // A click on the dialog element itself (not its content) is a backdrop click.
        if (e.target === e.currentTarget && !busy) {
          onClose();
        }
      }}
    >
      <div className="modal-card">
        <header className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" disabled={busy} onClick={onClose}>
            ×
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
