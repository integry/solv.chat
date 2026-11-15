import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { type MountAdminOptions, resolveAdminConfig } from "./extension.js";

export interface AdminMount {
  unmount: () => void;
}

/**
 * Mounts the solv.chat admin app into `root`. Validates extension options
 * synchronously before rendering so built-in id or route clashes fail fast.
 */
export function mountAdmin(root: HTMLElement, options?: MountAdminOptions): AdminMount {
  const config = resolveAdminConfig(options);
  const reactRoot = createRoot(root);
  reactRoot.render(
    <StrictMode>
      <App config={config} />
    </StrictMode>,
  );
  return {
    unmount: () => {
      reactRoot.unmount();
    },
  };
}
