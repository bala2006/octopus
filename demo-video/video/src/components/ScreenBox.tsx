import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import frames from "../frames.json";
import { C, FONT } from "../theme";
import { ease, kf, prog, tornRect } from "../lib";
import { Tape } from "./marks";

export type Cam = { f: number; cx: number; cy: number; z: number };

/** Piecewise ease-in-out camera between keyframes (source pixel space 1920x1080). */
function camAt(g: number, cams: Cam[]) {
  if (!cams.length) return { cx: 960, cy: 540, z: 1 };
  if (g <= cams[0].f) return cams[0];
  for (let i = 0; i < cams.length - 1; i++) {
    const a = cams[i], b = cams[i + 1];
    if (g < b.f) {
      const p = ease.inOut(Math.min(1, Math.max(0, (g - a.f) / Math.max(1, b.f - a.f))));
      // zoom interpolates in log space so it feels even
      const z = Math.exp(Math.log(a.z) + (Math.log(b.z) - Math.log(a.z)) * p);
      return { cx: a.cx + (b.cx - a.cx) * p, cy: a.cy + (b.cy - a.cy) * p, z };
    }
  }
  return cams[cams.length - 1];
}

/** Footage time (seconds) at global frame g from [frame, seconds] pairs; keeps real-time after the last pair. */
export function remap(g: number, map: [number, number][]) {
  if (g <= map[0][0]) return map[0][1];
  for (let i = 0; i < map.length - 1; i++) {
    const [f1, s1] = map[i], [f2, s2] = map[i + 1];
    if (g < f2) return s1 + ((g - f1) / (f2 - f1)) * (s2 - s1);
  }
  const [fl, sl] = map[map.length - 1];
  return sl + (g - fl) / 30;
}

/** Base URL of the local frame server started by render.sh (serves octopus-demo/capture/). */
export const FRAME_HOST = "http://127.0.0.1:9876";
const STREAMS = frames as unknown as Record<string, { dir: string; ts: number[]; n: number[] }>;

/** The screencast frame on screen at `sec` seconds into a stream (last frame painted at or before that time). */
export function frameUrl(src: string, sec: number) {
  const st = STREAMS[src];
  const t = sec * 1000;
  let lo = 0, hi = st.ts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (st.ts[mid] <= t) lo = mid; else hi = mid - 1; }
  return `${FRAME_HOST}/${st.dir}/${String(st.n[lo]).padStart(6, "0")}.jpg`;
}

/** Real screen recording (CDP screencast frames), time-remapped onto the narration. */
export const Footage: React.FC<{ src: string; map: [number, number][]; from?: number; to?: number; fade?: number; maxSec?: number }> = ({ src, map, from = -1e9, to = 1e9, fade = 6, maxSec }) => {
  const g = useCurrentFrame();
  if (g < from || g >= to) return null;
  let s = remap(g, map);
  if (maxSec !== undefined) s = Math.min(s, maxSec);
  const o = Math.min(prog(g, from, fade), 1 - prog(g, to - fade, fade));
  return (
    <AbsoluteFill style={{ opacity: from < -1e8 ? 1 : o }}>
      <Img src={frameUrl(src, Math.max(0, s))} style={{ width: 1920, height: 1080 }} />
    </AbsoluteFill>
  );
};

export const Shot: React.FC<{ src: string; from?: number; to?: number; fade?: number; style?: React.CSSProperties }> = ({ src, from = -1e9, to = 1e9, fade = 6, style }) => {
  const g = useCurrentFrame();
  if (g < from || g >= to) return null;
  const o = from < -1e8 ? 1 : Math.min(prog(g, from, fade), 1 - prog(g, to - fade, fade));
  return <Img src={staticFile(`shots/${src}`)} style={{ position: "absolute", left: 0, top: 0, width: 1920, height: 1080, opacity: o, ...style }} />;
};

/**
 * A taped, paper-matted app window showing the real software. Children are laid out in 1920x1080 source
 * pixels and move with the camera, so callouts stay locked to the UI.
 */
export const ScreenBox: React.FC<{
  at: number; x: number; y: number; w: number; exit?: number; rotate?: number; url?: string; cams?: Cam[];
  badge?: (g: number) => React.ReactNode; children: React.ReactNode; tapes?: boolean; enterFrom?: "bottom" | "right" | "left"; light?: boolean;
  moveTo?: { f: number; x: number; y: number; w: number; dur?: number };
}> = ({ at, x, y, w, exit, rotate = -0.5, url = "127.0.0.1:8000", cams = [], badge, children, tapes = true, enterFrom = "bottom", light, moveTo }) => {
  const g = useCurrentFrame();
  if (g < at) return null;
  let bx = x, by = y, bw = w;
  if (moveTo) {
    const p = prog(g, moveTo.f, moveTo.dur ?? 16, ease.inOut);
    bx = x + (moveTo.x - x) * p; by = y + (moveTo.y - y) * p; bw = w + (moveTo.w - w) * p;
  }
  const lt = g - at;
  const enter = prog(lt, 0, 16, ease.out);
  const off = (1 - enter) * 1150;
  const tx = enterFrom === "right" ? off : enterFrom === "left" ? -off : 0;
  const ty = enterFrom === "bottom" ? off : 0;
  const rot = rotate + (1 - enter) * (enterFrom === "left" ? -5 : 5);
  let opacity = 1, blur = 0;
  if (exit !== undefined && g >= exit) { const p = prog(g, exit, 6, ease.in); if (p >= 1) return null; opacity = 1 - p; blur = p * 14; }
  const bar = Math.round(bw * 0.028);
  const h = (bw * 9) / 16;
  const s = bw / 1920;
  const cam = camAt(g, cams);
  const z = Math.max(1, cam.z);
  let ox = 960 - cam.cx * z, oy = 540 - cam.cy * z;
  ox = Math.min(0, Math.max(1920 - 1920 * z, ox));
  oy = Math.min(0, Math.max(1080 - 1080 * z, oy));
  const mat = 22;
  return (
    <div style={{ position: "absolute", left: bx, top: by, width: bw, height: h + bar, transform: `translate(${tx}px, ${ty}px) rotate(${rot}deg)`, opacity, filter: blur ? `blur(${blur}px)` : undefined, zIndex: 5 }}>
      {/* paper mat */}
      <svg width={bw + mat * 2 + 20} height={h + bar + mat * 2 + 20} style={{ position: "absolute", left: -mat - 10, top: -mat - 10, overflow: "visible", filter: "drop-shadow(0 18px 26px rgba(0,0,0,0.35))" }}>
        <g transform="translate(10 10)"><polygon points={tornRect(bw + mat * 2, h + bar + mat * 2, 21, 5, 16)} fill={light ? "#FFFFFF" : C.card} /></g>
      </svg>
      {/* window */}
      <div style={{ position: "absolute", inset: 0, borderRadius: 12, overflow: "hidden", background: C.app, boxShadow: "0 0 0 1.5px rgba(0,0,0,0.55)" }}>
        <div style={{ position: "absolute", left: 0, top: 0, right: 0, height: bar, background: C.appBar, display: "flex", alignItems: "center", paddingLeft: bar * 0.55, gap: bar * 0.28 }}>
          {["#FF5F57", "#FEBC2E", "#28C840"].map((c) => <div key={c} style={{ width: bar * 0.36, height: bar * 0.36, borderRadius: 99, background: c }} />)}
          <div style={{ position: "absolute", left: "50%", transform: "translateX(-50%)", height: bar * 0.62, padding: `0 ${bar * 0.7}px`, borderRadius: 99, background: "#1A1918", color: "#B9B4AC", fontFamily: FONT.ui, fontSize: bar * 0.36, display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>
            <span style={{ width: bar * 0.22, height: bar * 0.22, borderRadius: 2, border: "1.5px solid #8A847D" }} />{url}
          </div>
          {badge && <div style={{ position: "absolute", right: bar * 0.5, display: "flex", alignItems: "center", gap: 10 }}>{badge(g)}</div>}
        </div>
        <div style={{ position: "absolute", left: 0, top: bar, width: bw, height: h, overflow: "hidden" }}>
          <div style={{ position: "absolute", left: 0, top: 0, width: 1920, height: 1080, transformOrigin: "0 0", transform: `scale(${s}) translate(${ox}px, ${oy}px) scale(${z})` }}>
            {children}
          </div>
        </div>
      </div>
      {tapes && <><Tape x={-58} y={-26} rotate={-32} w={150} /><Tape x={bw - 92} y={-26} rotate={30} w={150} /></>}
    </div>
  );
};

/** "REAL RUN" chip: a live dot plus the run clock and playback speed. */
export const RunBadge: React.FC<{ g: number; clock?: string; speed?: string; size?: number }> = ({ g, clock, speed, size = 15 }) => (
  <>
    {speed && <div style={{ fontFamily: FONT.typewriter, fontWeight: 700, fontSize: size, letterSpacing: "0.1em", color: "#F1D01A" }}>{speed}</div>}
    <div style={{ display: "flex", alignItems: "center", gap: 7, fontFamily: FONT.typewriter, fontWeight: 700, fontSize: size, letterSpacing: "0.1em", color: "#F3F0EB", background: "rgba(210,37,29,0.9)", padding: "3px 10px", borderRadius: 4 }}>
      <span style={{ width: size * 0.55, height: size * 0.55, borderRadius: 99, background: "#fff", opacity: Math.floor(g / 15) % 2 ? 1 : 0.35 }} />
      {clock ?? "REAL RUN"}
    </div>
  </>
);

/** mm:ss of the run clock for a source time (run started at 47.6 s into the recording). */
export const runClock = (srcSec: number) => {
  const t = Math.max(0, srcSec - 47.6);
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `RUN ${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

