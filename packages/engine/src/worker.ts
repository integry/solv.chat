import { createApp, type Env } from "./app.js";
import { basicLimits } from "./seams/open/basicLimits.js";
import { type PasswordAuthEnv, passwordAuth } from "./seams/open/passwordAuth.js";
import { type SecretKeyEnv, secretKeys } from "./seams/open/secretKeys.js";
import { usageDaily } from "./seams/open/usageDaily.js";

export type WorkerEnv = Env & PasswordAuthEnv & SecretKeyEnv;

function buildApp(env: WorkerEnv) {
  return createApp({
    auth: passwordAuth(env, env.DB),
    keys: secretKeys(env),
    usage: usageDaily(env.DB),
    limits: basicLimits(env.DB),
  });
}

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    return buildApp(env).fetch(request, env, ctx);
  },
  queue(batch: MessageBatch<unknown>, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    return buildApp(env).queue(batch, env, ctx);
  },
} satisfies ExportedHandler<WorkerEnv>;
