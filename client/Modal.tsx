import { ui } from './language';
import { useEffect, useRef, type RefObject, type ReactNode } from 'react';
import { ChevronLeft, X } from 'lucide-react';

export function Modal({ title, subtitle, children, onClose, initialFocus, page = false, closeDisabled = false }: { title: string; subtitle?: string; initialFocus?: RefObject<HTMLElement | null>; page?: boolean; closeDisabled?: boolean; children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    element?.showModal();
    const target = initialFocus?.current ?? panel.current;
    target?.focus({ preventScroll: true });
    return () => {
      element?.close();
      if (document.activeElement === document.body && opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [initialFocus]);
  useEffect(() => {
    const element = dialog.current;
    const viewport = window.visualViewport;
    if (!element || !viewport) return;
    let frame = 0;
    function update() {
      if (!element || !viewport) return;
      const field = document.activeElement;
      const editing = (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) &&
        field.closest('dialog') === element && viewport.scale === 1;
      element.toggleAttribute('data-editing', editing);
      if (!editing) return;
      element.style.setProperty('--visible-top', viewport.offsetTop + 'px');
      element.style.setProperty('--visible-height', viewport.height + 'px');
      const rect = field.getBoundingClientRect();
      if (rect.bottom > viewport.offsetTop + viewport.height || rect.top < viewport.offsetTop) {
        field.scrollIntoView({ block: 'nearest' });
      }
    }
    function schedule() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    }
    schedule();
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    element.addEventListener('focusin', schedule);
    element.addEventListener('focusout', schedule);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
      element.removeEventListener('focusin', schedule);
      element.removeEventListener('focusout', schedule);
    };
  }, []);
  return <dialog ref={dialog} className={page ? "modal-backdrop profile-page" : "modal-backdrop"} aria-label={title}
    onCancel={(event) => { event.stopPropagation(); event.preventDefault(); if (!closeDisabled) onClose(); }}
    onClick={(event) => { if (!closeDisabled && event.target === event.currentTarget) onClose(); }}>
    <section ref={panel} className="modal" tabIndex={-1}>
      <header className="modal-header">{page && <button type="button" className="icon-button" disabled={closeDisabled} aria-label={ui("会話に戻る", "Back to chat")} onClick={onClose}><ChevronLeft size={23} /></button>}<div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{!page && <button className="icon-button" disabled={closeDisabled} aria-label={ui("閉じる", "Close")} onClick={onClose}><X size={19} /></button>}</header>
      {children}
    </section>
  </dialog>;
}
