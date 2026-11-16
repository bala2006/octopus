import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".txt": "text/plain" };

/** Serves the files in `<root>/public`. */
export function createStaticServer(root) {
  const publicDir = path.join(root, "public");
  return createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const file = path.join(publicDir, pathname === "/" ? "index.html" : pathname);
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
}
