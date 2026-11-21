/** Mounts a widget and simulates early launcher intent for tests of the loaded panel. */
export function mountWithIntent(widget: HTMLElement): void {
  document.body.append(widget);
  widget.shadowRoot?.querySelector(".solv-launcher")?.dispatchEvent(new Event("pointerenter"));
}
