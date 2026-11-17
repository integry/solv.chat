import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Focusable descendants of `root` in tab order, skipping hidden subtrees. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.closest("[hidden]") && !el.closest("[inert]"),
  );
}

export interface FocusTrapOptions {
  /** Called on Escape. */
  onEscape?: (() => void) | undefined;
  /** Element to focus first; defaults to the first focusable element. */
  initialFocus?: RefObject<HTMLElement | null> | undefined;
}

/**
 * Keeps keyboard focus inside `ref` while `active`: focus moves in on
 * activation, Tab and Shift+Tab wrap, Escape calls `onEscape`, and focus goes
 * back to where it was on deactivation. Spread the returned `onKeyDown` on the
 * container; it is a React handler so nested widgets (menus, listboxes) can
 * stop Escape from reaching it.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  options: FocusTrapOptions = {},
): { onKeyDown: (event: KeyboardEvent) => void } {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = ref.current;
    if (root) {
      const target = optionsRef.current.initialFocus?.current ?? focusableWithin(root)[0] ?? root;
      target.focus();
    }
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [active, ref]);

  function onKeyDown(event: KeyboardEvent) {
    if (!active || event.defaultPrevented) return;
    // React bubbles events from portals through the component tree, so a
    // dialog opened from inside this container (rendered into document.body)
    // reaches this handler too. That dialog owns its keys; leave them alone.
    const root = ref.current;
    if (root && event.target instanceof Node && !root.contains(event.target)) return;
    if (event.key === "Escape") {
      if (optionsRef.current.onEscape) {
        event.preventDefault();
        event.stopPropagation();
        optionsRef.current.onEscape();
      }
      return;
    }
    if (event.key !== "Tab" || !root) return;
    const items = focusableWithin(root);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    const current = document.activeElement;
    if (event.shiftKey && (current === first || !root.contains(current))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (current === last || !root.contains(current))) {
      event.preventDefault();
      first.focus();
    }
  }

  return { onKeyDown };
}

/** Tracks a CSS media query. False where `matchMedia` is unavailable. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => readMedia(query));

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener?.("change", update);
    return () => list.removeEventListener?.("change", update);
  }, [query]);

  return matches;
}

function readMedia(query: string): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(query).matches;
}

/** Calls `onOutside` on a pointer press outside every element in `refs` while `active`. */
export function useOutsidePress(
  refs: ReadonlyArray<RefObject<HTMLElement | null>>,
  active: boolean,
  onOutside: () => void,
): void {
  const callbackRef = useRef(onOutside);
  callbackRef.current = onOutside;
  const refsRef = useRef(refs);
  refsRef.current = refs;

  useEffect(() => {
    if (!active) return;
    const handler = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (refsRef.current.some((r) => r.current?.contains(target))) return;
      callbackRef.current();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [active]);
}
