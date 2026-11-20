// Usage:
//   npx tsx render.ts stills <frame> [<frame> ...]    -> out/stills/f<frame>.png
//   npx tsx render.ts video [out.mp4] [from] [to]     -> H.264 + AAC
import path from "node:path";
import { mkdirSync } from "node:fs";
import { bundle } from "@remotion/bundler";
import { ensureBrowser, renderMedia, renderStill, selectComposition } from "@remotion/renderer";

import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const [mode, ...args] = process.argv.slice(2);

// Serve the screencast frames (capture/) to the renderer. Read-only, localhost only, paths confined to CAPTURE.
const CAPTURE = path.resolve(ROOT, "..", "capture");
const frameServer = createServer((req, res) => {
  const p = path.resolve(CAPTURE, "." + decodeURIComponent((req.url ?? "/").split("?")[0]));
  if (!p.startsWith(CAPTURE + path.sep) || !p.endsWith(".jpg") || !existsSync(p)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "Content-Type": "image/jpeg", "Access-Control-Allow-Origin": "*", "Cache-Control": "max-age=31536000" });
  createReadStream(p).pipe(res);
});
await new Promise<void>((r) => frameServer.listen(9876, "127.0.0.1", () => r()));

const serveUrl = await bundle({ entryPoint: path.join(ROOT, "src", "index.tsx"), publicDir: path.join(ROOT, "public"), outDir: path.join(ROOT, "out", "bundle") });
await ensureBrowser();
const composition = await selectComposition({ serveUrl, id: "OctopusDemo", logLevel: "error" });
console.log(`composition: ${composition.durationInFrames} frames (${(composition.durationInFrames / 30).toFixed(1)} s)`);

if (mode === "stills") {
  mkdirSync(path.join(ROOT, "out", "stills"), { recursive: true });
  for (const a of args) {
    const frame = Number(a);
    const output = path.join(ROOT, "out", "stills", `f${frame}.png`);
    await renderStill({ composition, serveUrl, frame, output, imageFormat: "png", logLevel: "error" });
    console.log(output);
  }
} else {
  const output = path.resolve(args[0] ?? path.join(ROOT, "out", "octopus-demo.mp4"));
  const from = args[1] !== undefined ? Number(args[1]) : undefined;
  const to = args[2] !== undefined ? Number(args[2]) : undefined;
  let last = -5;
  const t0 = Date.now();
  await renderMedia({
    composition, serveUrl, codec: "h264", audioCodec: "aac", audioBitrate: "192k", crf: 17, x264Preset: "medium", pixelFormat: "yuv420p",
    outputLocation: output, frameRange: from !== undefined ? [from, to ?? composition.durationInFrames - 1] : null,
    concurrency: Number(process.env.CONCURRENCY ?? 6), logLevel: "error", offthreadVideoCacheSizeInBytes: 2 * 1024 ** 3,
    onProgress: ({ progress }) => { const p = Math.floor(progress * 100); if (p >= last + 5) { last = p; console.log(`render ${p}%  ${((Date.now() - t0) / 1000).toFixed(0)}s`); } },
  });
  console.log("done", output, ((Date.now() - t0) / 1000).toFixed(0) + "s");
}
frameServer.close(); process.exit(0);
