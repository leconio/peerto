import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config/app-config";
import { registerCorePlugins } from "./plugins/core";
import { registerApiRoutes } from "./routes/api-routes";
import { registerStaticAssets } from "./routes/static-assets";
import { registerSignalingRoutes } from "./signaling/register-signaling";
import {
  CloudflareTurnstileVerifier,
  type TurnstileVerifier,
} from "./security/turnstile";
import type { RuntimeRoomMap } from "./signaling/runtime-room";
import type { RoomStore } from "./storage/room-store";

export interface BuildAppOptions {
  config: AppConfig;
  store: RoomStore;
  logger?: boolean;
  turnstileVerifier?: TurnstileVerifier;
}

export async function buildApp({
  config,
  store,
  logger = true,
  turnstileVerifier,
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger ? { redact: ["req.url"] } : false,
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 128 * 1024,
  });
  const runtimeRooms: RuntimeRoomMap = new Map();

  await registerCorePlugins(app);
  const verifier =
    turnstileVerifier ||
    (config.TURNSTILE_SECRET_KEY
      ? new CloudflareTurnstileVerifier({
          secretKey: config.TURNSTILE_SECRET_KEY,
          allowedHostnames: config.TURNSTILE_ALLOWED_HOSTNAMES,
        })
      : undefined);
  registerApiRoutes(app, {
    config,
    store,
    runtimeRooms,
    ...(verifier ? { turnstileVerifier: verifier } : {}),
  });
  registerSignalingRoutes(app, { config, store, runtimeRooms });
  await registerStaticAssets(app, config.WEB_DIST);

  app.addHook("onClose", async () => {
    store.close();
  });

  return app;
}
