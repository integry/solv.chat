import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    environmentOptions: {
      happyDOM: {
        // The Widget screen's preview frame loads /widget.js; there is no
        // server behind happy-dom, so script loading is off for every test
        // (the Chromium layout test runs the real preview).
        settings: {
          disableJavaScriptFileLoading: true,
          handleDisabledFileLoadingAsSuccess: true,
          navigation: { disableChildFrameNavigation: true },
        },
      },
    },
  },
});
