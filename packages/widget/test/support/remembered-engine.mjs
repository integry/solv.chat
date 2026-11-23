// A local Worker using the real public chat, feedback and session routes.
import { defaultVersionConfig } from "@solvchat/core";
import { createApp } from "../../../engine/src/app.ts";
import { SITEVERIFY_URL } from "../../../engine/src/chat/turnstile.ts";
import { forPrincipal } from "../../../engine/src/db/tenant.ts";
import { ANTHROPIC_MODELS } from "../../../engine/src/models.ts";
import { fakeEmbedder } from "../../../engine/test/fakes/fakeEmbedder.ts";
import { memoryRetriever } from "../../../engine/test/fakes/memoryRetriever.ts";

const orgId = "org_widget_browser";
const principal = { orgId, userId: "owner", role: "owner" };
let holdReply = false;

const app = createApp(
  {
    auth: { resolveOrg: async () => orgId, authenticate: async () => principal },
    limits: { check: async () => ({ ok: true }) },
    keys: {
      modelKey: async () => "test-model-key",
      embeddingKey: async () => "test-embedding-key",
    },
    usage: {
      async record({ messages }) {
        // Delay completion after the fallback answer has streamed a token.
        while (messages > 0 && holdReply) await new Promise((resolve) => setTimeout(resolve, 20));
      },
    },
  },
  {
    chat: {
      embedder: fakeEmbedder(),
      retriever: memoryRetriever(),
      provider: { name: "anthropic", model: ANTHROPIC_MODELS.balanced.id, async *stream() {} },
    },
    async fetch(input) {
      if (input !== SITEVERIFY_URL) throw new Error("Unexpected provider request");
      return Response.json({ success: true, hostname: "example.com" });
    },
  },
);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/test/seed") {
      await env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2)")
        .bind(orgId, "Widget browser test")
        .run();
      const tenant = forPrincipal(env.DB, principal);
      const assistantId = "ast_browser";
      await tenant.assistants.create({
        id: assistantId,
        name: "Product help",
        publicKey: "pk_remembered",
        allowedOrigins: [env.SITE_ORIGIN],
        createdAt: Date.now(),
      });
      const config = defaultVersionConfig();
      config.widget.title = "Product help";
      config.behaviour.fallbackText =
        "I couldn’t find that in the help center. You can contact support for more details.";
      const draft = await tenant.versions.createDraft({
        id: "ver_browser",
        assistantId,
        config,
        createdAt: Date.now(),
      });
      await tenant.versions.publishDraft(assistantId, draft.id, "ver_browser_next", Date.now());
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/test/hold") {
      holdReply = true;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/test/release") {
      holdReply = false;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/v1/check/frame") {
      // Stand in for the third-party challenge. The widget still exchanges
      // this token with the real Worker route and chat verifies the session.
      const parent = url.searchParams.get("parent");
      if (parent !== env.SITE_ORIGIN) return new Response(null, { status: 403 });
      return new Response(
        `<!doctype html><script>
          parent.postMessage({solvCheck:1,type:"ready"}, ${JSON.stringify(parent)});
          parent.postMessage({solvCheck:1,type:"token",token:"XXXX.DUMMY.TOKEN.XXXX"}, ${JSON.stringify(parent)});
        </script>`,
        { headers: { "content-type": "text/html" } },
      );
    }
    return app.fetch(request, env, ctx);
  },
};
