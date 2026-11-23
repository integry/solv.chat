import {
  type DockPlaceholder,
  type DockRecord,
  dockKey,
  reserveRoom,
  SIDE_BY_SIDE_MIN_WIDTH_PX,
} from "./dock.js";

try {
  const doc = document;
  const id = dockKey((doc.currentScript as HTMLElement).dataset.key as string);
  const raw = sessionStorage[id];
  if (raw && innerWidth >= SIDE_BY_SIDE_MIN_WIDTH_PX) {
    let copied: string | undefined;
    try {
      copied = opener.sessionStorage[id];
    } catch {
      // An opener on another origin cannot have copied this origin's record.
    }
    const [side, width, css, title] = JSON.parse(raw) as DockRecord;
    // The widget's CSS uses literal values. This alphabet excludes CSS
    // functions, escapes and URLs even when the storage has been corrupted.
    if (
      raw !== copied &&
      (side === "left" || side === "right") &&
      width === "460px" &&
      typeof title === "string" &&
      css.match(/^position:fixed;[#a-z0-9:;, -]+$/)
    ) {
      const panel: DockPlaceholder = doc.createElement("div");
      panel.id = id;
      panel.inert = true;
      panel.style.cssText = css;
      panel.textContent = title;
      const root = doc.documentElement;
      const original = root.getAttribute("style");
      panel.rootStyle = original;
      reserveRoom(root, side, width);
      setTimeout(() => {
        if (panel.isConnected) {
          panel.remove();
          if (original === null) root.removeAttribute("style");
          else root.setAttribute("style", original);
        }
      }, 3000);
      root.append(panel);
    }
  }
} catch {
  // Storage or the record may be unavailable. Leave the page alone.
}
