import { createServer } from "vite";

const server = await createServer();
await server.listen();

let stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  await server.close();
  process.exit(0);
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
