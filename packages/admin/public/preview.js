// The Widget screen's live preview. This page runs in a sandboxed frame with
// no same-origin access, no assistant key and a policy without connect-src.
// It shows whatever settings the admin page posts to it, and nothing else.
// A static file, not inline, so the admin's script-src 'self' allows it.
(() => {
  let latest = null;
  const show = () => {
    const el = document.querySelector("solv-chat");
    if (latest !== null && el && typeof el.preview === "function")
      el.preview(latest, latest.showPanel);
  };
  addEventListener("message", (event) => {
    if (event.source !== parent) return;
    latest = event.data;
    customElements.whenDefined("solv-chat").then(show);
  });
  parent.postMessage("solv-preview-ready", "*");
})();
