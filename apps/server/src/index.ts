import { buildApp } from "./app";
import { readConfig } from "./config/app-config";
import { InMemoryRoomStore } from "./storage/room-store";

const config = readConfig();
const store = new InMemoryRoomStore({
  maxRooms: config.MAX_PENDING_ROOMS,
  maxCodes: config.MAX_CODE_RECORDS,
  maxRateBuckets: config.MAX_RATE_BUCKETS,
});
const app = await buildApp({
  config,
  store,
});

const shutdown = async (): Promise<void> => {
  await app.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await app.listen({ host: config.HOST, port: config.PORT });
