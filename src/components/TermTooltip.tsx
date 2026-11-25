import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { GLOSSARY, type GlossaryEntry } from '../lib/glossary';

const TOOLTIP_ID = 'term-tooltip';
/** VS Code waits a moment before showing a hover, so sweeping the pointer across does not flash. */
const SHOW_DELAY_MS = 350;
const GAP = 6;
const EDGE = 8;

interface Shown {
  target: HTMLElement;
  entry: GlossaryEntry;
}

function termTarget(node: EventTarget | null): HTMLElement | null {
  return node instanceof Element ? node.closest<HTMLElement>('[data-term]') : null;
}

/**
 * The single hover widget explaining memory terms. Mounted once; any element
 * with `data-term="<glossary key>"` gets it on pointer hover (after a short
 * delay) and on keyboard focus (at once), wired up through aria-describedby.
 */
export function TermTooltip() {
  const [shown, setShown] = useState<Shown | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timer = useRef(0);

  useEffect(() => {
    function show(target: HTMLElement) {
      const key = target.dataset.term as keyof typeof GLOSSARY | undefined;
      const entry = key ? GLOSSARY[key] : undefined;
      if (entry) setShown((prev) => (prev?.target === target ? prev : { target, entry }));
    }
    function hide() {
      window.clearTimeout(timer.current);
      setShown(null);
    }

    function onPointerOver(e: PointerEvent) {
      const target = termTarget(e.target);
      window.clearTimeout(timer.current);
      if (!target) return;
      timer.current = window.setTimeout(() => show(target), SHOW_DELAY_MS);
    }
    function onPointerOut(e: PointerEvent) {
      const from = termTarget(e.target);
      if (from && from !== termTarget(e.relatedTarget)) hide();
    }
    function onFocusIn(e: FocusEvent) {
      const target = termTarget(e.target);
      if (target && (e.target as Element).matches(':focus-visible')) show(target);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') hide();
    }

    document.addEventListener('pointerover', onPointerOver);
    document.addEventListener('pointerout', onPointerOut);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', hide);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', hide, true);
    return () => {
      window.clearTimeout(timer.current);
      document.removeEventListener('pointerover', onPointerOver);
      document.removeEventListener('pointerout', onPointerOut);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', hide, true);
    };
  }, []);

  // Point the term at its explanation while it is on screen.
  useEffect(() => {
    if (!shown) return;
    const { target } = shown;
    const previous = target.getAttribute('aria-describedby');
    target.setAttribute('aria-describedby', TOOLTIP_ID);
    return () => {
      if (previous === null) target.removeAttribute('aria-describedby');
      else target.setAttribute('aria-describedby', previous);
    };
  }, [shown]);

  // Below the term, flipped above when it would leave the viewport, clamped to the sides.
  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (!shown || !tooltip) {
      setPosition(null);
      return;
    }
    const rect = shown.target.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = tooltip;
    let top = rect.bottom + GAP;
    if (top + h > window.innerHeight - EDGE && rect.top - GAP - h >= EDGE) top = rect.top - GAP - h;
    const left = Math.min(Math.max(EDGE, rect.left), window.innerWidth - w - EDGE);
    setPosition({ left, top });
  }, [shown]);

  if (!shown) return null;

  return (
    <div
      id={TOOLTIP_ID}
      ref={tooltipRef}
      role="tooltip"
      className="term-tooltip"
      style={position ?? { left: 0, top: 0, visibility: 'hidden' }}
    >
      <div className="term-tooltip__title">{shown.entry.title}</div>
      <div className="term-tooltip__body">{shown.entry.body}</div>
      {shown.entry.source && <div className="term-tooltip__source">{shown.entry.source}</div>}
    </div>
  );
}
