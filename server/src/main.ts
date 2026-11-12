/** Start the Octopus server. */
import { config } from "./config";
import { openRegistry } from "./db/registry";
import { buildServer } from "./http/server";
import { closeIdle } from "./services/mcp";
import { stopAll } from "./workspace/processes";

const reg = openRegistry();
const app = await buildServer(reg, { logger: true });

const shutdown = async () => {
  stopAll();
  await closeIdle(0);
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host: config.host, port: config.port });
console.log(`Octopus is running on http://${config.host}:${config.publicPort}`);
