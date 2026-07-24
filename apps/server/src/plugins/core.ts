import helmet from "@fastify/helmet";
import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";

export async function registerCorePlugins(
  app: FastifyInstance,
): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "https://challenges.cloudflare.com",
        ],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "blob:", "data:"],
        mediaSrc: ["'self'", "blob:"],
        connectSrc: ["'self'", "ws:", "wss:"],
        frameSrc: ["https://challenges.cloudflare.com"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
  });
  await app.register(websocket, {
    options: { maxPayload: 256 * 1024 },
  });
}
