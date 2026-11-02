import * as React from "react";
import { createPortal } from "react-dom";

type Hint = { label: string; left: number; top: number; below: boolean; rail: boolean };

function getTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const control = target.closest<HTMLElement>("button, a.rail-item, [role='tab']");
  if (!control || control.matches(":disabled, [aria-disabled='true']")) return null;
  if (control.hasAttribute("data-tooltip-managed")) return null;
  return control;
}

function getLabel(control: HTMLElement): string {
  return (control.getAttribute("aria-label") || control.getAttribute("title") || control.innerText || control.textContent || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function HoverHints() {
  const [hint, setHint] = React.useState<Hint | null>(null);
  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const showFor = (control: HTMLElement | null) => {
      if (timer) clearTimeout(timer);
      setHint(null);
      if (!control) return;
      const label = getLabel(control);
      if (!label) return;
      timer = setTimeout(() => {
        const rect = control.getBoundingClientRect();
        const rail = control.matches(".activity-rail .rail-item");
        const below = rect.top < 42;
        setHint({
          label,
          left: rail ? rect.right + 8 : Math.max(12, Math.min(rect.left + rect.width / 2, window.innerWidth - 12)),
          top: rail ? rect.top + rect.height / 2 : below ? rect.bottom + 8 : rect.top - 8,
          below,
          rail,
        });
      }, 420);
    };
    const onPointerOver = (event: PointerEvent) => {
      const control = getTarget(event.target);
      if (control && event.relatedTarget instanceof Node && control.contains(event.relatedTarget)) return;
      showFor(control);
    };
    const onPointerOut = (event: PointerEvent) => {
      const control = getTarget(event.target);
      if (control && event.relatedTarget instanceof Node && control.contains(event.relatedTarget)) return;
      if (control) showFor(null);
    };
    const onFocusIn = (event: FocusEvent) => showFor(getTarget(event.target));
    const onFocusOut = (event: FocusEvent) => {
      const control = getTarget(event.target);
      if (control) showFor(null);
    };
    const onScroll = () => showFor(null);
    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointerout", onPointerOut, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointerout", onPointerOut, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, []);

  if (!hint) return null;
  return createPortal(
    <div role="tooltip" className={`ui-button-tooltip ui-hover-hint${hint.below ? " is-below" : ""}${hint.rail ? " is-rail" : ""}`} style={{ left: hint.left, top: hint.top }}>
      {hint.label}
    </div>,
    document.body,
  );
}
