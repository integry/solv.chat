export const SIDE_PANEL_WIDTH = "460px";
export const SIDE_BY_SIDE_MIN_WIDTH_PX = 900;
export const PANEL_WIDTH_PROPERTY = "--solv-chat-panel-width";
export const DOCK_NAME = "solv-chat-dock";
export const dockKey = (assistant: string): string => `solv-dock:1:${assistant}`;

export type Side = "left" | "right";
export type DockRecord = [side: Side, width: string, css: string, title: string, tabId: string];

export interface DockPlaceholder extends HTMLElement {
  // Present only on the placeholder inserted by the boot script.
  rootStyle?: string | null;
}

export function reserveRoom(root: HTMLElement, side: Side, width: string): void {
  const style = root.style;
  const computed = getComputedStyle(root);
  const max = computed.maxWidth;
  const margin = `margin-${side}`;
  const existing = style.getPropertyValue(margin);
  const put = (key: string, value: string) => style.setProperty(key, value, "important");
  put(margin, width);
  if (existing) put(margin, `calc(${existing} + ${width})`);
  style.setProperty(PANEL_WIDTH_PROPERTY, width);

  // Use the difference between the border box and CSS width to include padding
  // and border for content-box roots. A set width must also be constrained.
  const px = (value: string) => parseFloat(value) || 0;
  const edges = root.getBoundingClientRect().width;
  const used =
    (edges && edges - px(computed.width)) + px(computed.marginLeft) + px(computed.marginRight);
  const room = `calc(100% - ${used}px)`;
  put("max-width", max && max !== "none" ? `min(${max}, ${room})` : room);
}

/** Release just our declarations and preserve other host edits. */
export function releaseRoom(side: Side, original: string | null): void {
  const root = document.documentElement;
  const style = root.style;
  const previous = document.createElement("div").style;
  previous.cssText = original ?? "";
  for (const key of [`margin-${side}`, "max-width", PANEL_WIDTH_PROPERTY]) {
    style.setProperty(key, previous.getPropertyValue(key), previous.getPropertyPriority(key));
  }
  root.getAttribute("style");
  if (style.cssText === previous.cssText) {
    if (original === null) root.removeAttribute("style");
    else root.setAttribute("style", original);
  }
}
