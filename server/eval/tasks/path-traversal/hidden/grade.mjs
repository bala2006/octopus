import { once } from "node:events";
import { writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SECRET = "TOP-SECRET-VALUE";
writeFileSync("secret.txt", SECRET);
const { createStaticServer } = await import(pathToFileURL(path.resolve("src/server.js")).href);
const server = createStaticServer(process.cwd());
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
const checks = [];

function get(requestPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: requestPath }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      })
      .on("error", reject);
  });
}

async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, pass: true });
  } catch (error) {
    checks.push({ name, pass: false, detail: String(error.message).split("\n")[0] });
  }
}

await check("a file in public/ is served", async () => {
  const res = await get("/index.html");
  if (res.status !== 200 || !res.body.includes("<h1>")) throw new Error(`status ${res.status}`);
});

await check("a missing file is 404", async () => {
  const res = await get("/missing.html");
  if (res.status !== 404) throw new Error(`status ${res.status}`);
});

for (const [name, requestPath] of [
  ["an encoded ../ with a slash", "/..%2fsecret.txt"],
  ["a fully encoded ../ with a slash", "/%2e%2e%2fsecret.txt"],
  ["an encoded ..\\ with a backslash", "/..%5csecret.txt"],
  ["a raw ../", "/../secret.txt"],
]) {
  await check(`${name} does not reveal a file outside public/`, async () => {
    const res = await get(requestPath);
    if (res.body.includes(SECRET)) throw new Error(`status ${res.status} returned the file`);
  });
}

server.closeAllConnections();
server.close();
console.log(JSON.stringify({ checks }));
