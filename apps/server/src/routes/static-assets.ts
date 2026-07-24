import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

export async function registerStaticAssets(
  app: FastifyInstance,
  webDist: string,
): Promise<void> {
  const indexPath = join(webDist, "index.html");
  if (!existsSync(indexPath)) return;

  await app.register(fastifyStatic, {
    root: webDist,
    wildcard: false,
    setHeaders: (response, filePath) => {
      if (
        /[\\/]assets[\\/]/.test(filePath) ||
        /[\\/]workbox-[a-zA-Z0-9_-]+\.js$/.test(filePath)
      ) {
        response.header(
          "Cache-Control",
          "public, max-age=31536000, immutable",
        );
      } else if (
        filePath.endsWith("/sw.js") ||
        filePath.endsWith("/registerSW.js") ||
        filePath.endsWith("/manifest.webmanifest") ||
        filePath.endsWith("/index.html")
      ) {
        response.header(
          "Cache-Control",
          "no-cache, no-store, must-revalidate",
        );
      }
    },
  });
  app.setNotFoundHandler((request, reply) => {
    if (
      request.method === "GET" &&
      !request.url.startsWith("/api/") &&
      !request.url.startsWith("/ws")
    ) {
      return reply.type("text/html").sendFile("index.html");
    }
    return reply.code(404).send({
      error: "NOT_FOUND",
      message: "请求的资源不存在",
    });
  });
}
