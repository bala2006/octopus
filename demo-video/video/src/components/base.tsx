import React from "react";
import { AbsoluteFill, interpolateColors, useCurrentFrame } from "remotion";
import { C, FONT } from "../theme";
import { ease, kf, prog, rand, tornRect } from "../lib";
import { sceneOf, sec } from "../time";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** For each displayed word, the frame of its next spoken occurrence after `from` (falls back to +4 frames). */
export function autoCues(sceneId: string, words: string[], from: number): number[] {
  const spoken = sceneOf(sceneId).lines.flatMap((l) => l.words).map((w) => ({ n: norm(w.w), f: sec(w.t) }));
  let i = spoken.findIndex((s) => s.f >= from - 2);
  if (i < 0) i = spoken.length;
  let last = from;
  return words.map((w) => {
    const want = norm(w);
    for (let j = i; j < Math.min(spoken.length, i + 14); j++) {
      const got = spoken[j].n;
      if (want && (got === want || (want.length >= 4 && got.startsWith(want.slice(0, 5))) || (got.length >= 4 && want.startsWith(got)))) {
        i = j + 1;
        last = spoken[j].f;
        return last;
      }
    }
    last += 4;
    return last;
  });
}

/** Mount/unmount with a Vox blur-out. Children see the global frame through useCurrentFrame(). */
export const Life: React.FC<{ at: number; exit?: number; dim?: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ at, exit, dim, children, style }) => {
  const g = useCurrentFrame();
  if (g < at) return null;
  let opacity = 1, blur = 0;
  if (exit !== undefined && g >= exit) {
    const p = prog(g, exit, 5, ease.in);
    if (p >= 1) return null;
    opacity = 1 - p; blur = p * 16;
  }
  if (dim !== undefined) opacity *= kf(g, [dim, dim + 8], [1, 0.38]);
  return <AbsoluteFill style={{ opacity, filter: blur ? `blur(${blur}px)` : undefined, ...style }}>{children}</AbsoluteFill>;
};

/** Ghost frame then rotated pop with 5% overshoot (Vox `cutout`). */
export function popStyle(lt: number, rotFrom = -8, rotTo = 0): React.CSSProperties {
  const scale = kf(lt, [0, 2, 5, 7, 10], [0.7, 0.88, 1.04, 0.99, 1.0], ease.out);
  const rot = kf(lt, [0, 6, 10], [rotFrom, rotTo + (rotTo - rotFrom) * 0.06, rotTo], ease.out);
  return { opacity: kf(lt, [0, 2], [0.3, 1]), transform: `scale(${scale}) rotate(${rot}deg)` };
}

export const Pop: React.FC<{ at: number; x: number; y: number; rotate?: number; origin?: string; children: React.ReactNode; z?: number }> = ({ at, x, y, rotate = 0, origin = "center", children, z }) => {
  const g = useCurrentFrame();
  if (g < at) return null;
  return <div style={{ position: "absolute", left: x, top: y, transformOrigin: origin, zIndex: z, ...popStyle(g - at, rotate - 9, rotate) }}>{children}</div>;
};

export const PaperBackground: React.FC<{ dark?: boolean }> = ({ dark }) => {
  if (dark) return <AbsoluteFill style={{ background: "#0B0A09" }} />;
  return (
    <AbsoluteFill style={{ background: C.paper }}>
      <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
        <defs>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M40 0 L0 0 0 40" fill="none" stroke="rgba(120,108,92,0.10)" strokeWidth="1" />
          </pattern>
          <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="4" /><feColorMatrix values="0 0 0 0 0.3  0 0 0 0 0.27  0 0 0 0 0.22  0 0 0 0.09 0" /></filter>
          <radialGradient id="vig" cx="50%" cy="50%" r="75%">
            <stop offset="0.55" stopColor={C.paper} stopOpacity="0" />
            <stop offset="0.86" stopColor={C.vignetteMid} stopOpacity="0.85" />
            <stop offset="1" stopColor={C.vignetteCorner} stopOpacity="1" />
          </radialGradient>
        </defs>
        <rect width="1920" height="1080" fill="url(#grid)" />
        <rect width="1920" height="1080" filter="url(#grain)" />
        <rect width="1920" height="1080" fill="url(#vig)" />
      </svg>
    </AbsoluteFill>
  );
};

/** Typewriter kicker in letter-spaced caps. */
export const Kicker: React.FC<{ text: string; at: number; y?: number; x?: number; dark?: boolean; size?: number; color?: string }> = ({ text, at, y = 46, x, dark, size = 26, color }) => {
  const g = useCurrentFrame();
  if (g < at) return null;
  const n = Math.min(text.length, Math.floor((g - at) * 1.3) + 1);
  return (
    <div style={{ position: "absolute", top: y, left: x ?? 0, width: x === undefined ? "100%" : undefined, textAlign: x === undefined ? "center" : "left", fontFamily: FONT.typewriter, fontWeight: 700, fontSize: size, letterSpacing: "0.14em", color: color ?? (dark ? C.onBlack : C.inkSoft), whiteSpace: "pre" }}>
      <span>{text.slice(0, n)}</span><span style={{ visibility: "hidden" }}>{text.slice(n)}</span>
    </div>
  );
};

const Marker: React.FC<{ p: number; seed: number; color?: string }> = ({ p, seed, color = C.yellow }) => (
  <span style={{
    position: "absolute", left: -6, right: -6, top: "20%", bottom: "4%", background: color, zIndex: -1,
    clipPath: `inset(0 ${(1 - p) * 100}% 0 0)`,
    borderRadius: `${3 + rand(seed) * 6}px ${2 + rand(seed + 1) * 8}px ${4 + rand(seed + 2) * 6}px ${2 + rand(seed + 3) * 5}px`,
    transform: `rotate(${(rand(seed + 4) - 0.5) * 1.2}deg)`,
  }} />
);

/**
 * Italic serif headline; each word fades pale -> ink on its spoken word. `**bold**`, `==highlight==`.
 * Pass `scene` to auto-sync words to narration, or `at` for a fixed staggered reveal.
 */
export const Headline: React.FC<{ text: string; scene?: string; at: number; y: number; size?: number; x?: number; align?: "center" | "left"; dark?: boolean; color?: string; width?: number; stagger?: number; lineHeight?: number }> = ({ text, scene, at, y, size = 68, x, align = "center", dark, color, width = 1700, stagger = 3, lineHeight = 1.15 }) => {
  const g = useCurrentFrame();
  const tokens: { word: string; bold: boolean; hl: boolean; br: boolean }[] = [];
  let bold = false, hl = false;
  for (const raw of text.split(/\s+/)) {
    if (raw === "/") { tokens.push({ word: "", bold, hl, br: true }); continue; }
    let w = raw;
    const sb = w.startsWith("**"), sh = w.startsWith("==");
    if (sb) { bold = true; w = w.slice(2); }
    if (sh) { hl = true; w = w.slice(2); }
    const eb = w.endsWith("**") || /\*\*[.,!?]$/.test(w), eh = w.endsWith("==") || /==[.,!?]$/.test(w);
    const clean = w.replace(/\*\*|==/g, "");
    tokens.push({ word: clean, bold, hl, br: false });
    if (eb) bold = false;
    if (eh) hl = false;
  }
  const words = tokens.filter((t) => !t.br).map((t) => t.word);
  const cues = scene ? autoCues(scene, words, at) : words.map((_, i) => at + i * stagger);
  if (g < at - 1) return null;
  const final = color ?? (dark ? C.onBlack : C.ink);
  const pale = dark ? "#4A4642" : C.pale;
  let wi = -1;
  const left = align === "center" ? (x ?? 960) - width / 2 : x ?? 150;
  return (
    <div style={{ position: "absolute", top: y, left, width, textAlign: align, fontFamily: FONT.headline, fontStyle: "italic", fontSize: size, lineHeight }}>
      {tokens.map((t, i) => {
        if (t.br) return <br key={i} />;
        wi++;
        const wf = cues[wi] - 1;
        const visible = g >= wf;
        const c = interpolateColors(g, [wf, wf + 4], [pale, final]);
        return (
          <React.Fragment key={i}>
            <span style={{ position: "relative", display: "inline-block", opacity: visible ? 1 : 0, color: t.hl ? C.ink : c, fontWeight: t.bold || t.hl ? 900 : 400, isolation: "isolate", transform: `translateY(${visible ? kf(g, [wf, wf + 5], [8, 0], ease.out) : 8}px)` }}>
              {t.hl && <Marker p={prog(g, wf, 5)} seed={i * 7 + 3} />}
              {t.word}
            </span>{" "}
          </React.Fragment>
        );
      })}
    </div>
  );
};

/** Big condensed text where each glyph rises out of a baseline mask. */
export const MaskRise: React.FC<{ text: string; at: number; size: number; color?: string; stagger?: number; style?: React.CSSProperties }> = ({ text, at, size, color = C.ink, stagger = 0.9, style }) => {
  const g = useCurrentFrame();
  const lt = g - at;
  if (lt < 0) return null;
  return (
    <div style={{ fontFamily: FONT.number, fontSize: size, lineHeight: 1.0, color, whiteSpace: "pre", ...style }}>
      {Array.from(text).map((ch, i) => {
        const p = prog(lt, i * stagger, 6);
        return (
          <span key={i} style={{ display: "inline-block", overflow: "hidden", verticalAlign: "top", paddingTop: size * 0.04 }}>
            <span style={{ display: "inline-block", transform: `translateY(${(1 - p) * 105}%)` }}>{ch === " " ? "\u00A0" : ch}</span>
          </span>
        );
      })}
    </div>
  );
};

export const BigText: React.FC<{ text: string; at: number; y: number; size?: number; color?: string; x?: number; align?: "center" | "left" }> = ({ text, at, y, size = 200, color, x, align = "center" }) => (
  <div style={{ position: "absolute", top: y, left: align === "center" ? 0 : x, width: align === "center" ? "100%" : undefined, display: "flex", justifyContent: align === "center" ? "center" : "flex-start", transform: align === "center" && x !== undefined ? `translateX(${x - 960}px)` : undefined }}>
    <MaskRise text={text} at={at} size={size} color={color} />
  </div>
);

export const Label: React.FC<{ text: string; at: number; x: number; y: number; size?: number; color?: string; align?: "left" | "center" | "right"; font?: "typewriter" | "ui" | "headline" }> = ({ text, at, x, y, size = 18, color = C.inkSoft, align = "left", font = "typewriter" }) => {
  const g = useCurrentFrame();
  if (g < at) return null;
  const tx = align === "center" ? "-50%" : align === "right" ? "-100%" : "0";
  return (
    <div style={{ position: "absolute", left: x, top: y, transform: `translateX(${tx}) translateY(${kf(g - at, [0, 6], [6, 0], ease.out)}px)`, opacity: prog(g, at, 5), fontFamily: FONT[font], fontStyle: font === "headline" ? "italic" : undefined, fontWeight: font === "typewriter" ? 700 : 500, letterSpacing: font === "typewriter" ? "0.14em" : undefined, fontSize: size, color, whiteSpace: "pre" }}>{text}</div>
  );
};

export const SourceLine: React.FC<{ text: string; at: number; dark?: boolean }> = ({ text, at, dark }) => {
  const g = useCurrentFrame();
  if (g < at) return null;
  return <div style={{ position: "absolute", left: 122, top: 1030, fontFamily: FONT.typewriter, fontSize: 16, color: dark ? "#6B6762" : C.greyText, opacity: prog(g, at, 6) }}>{text}</div>;
};

export const TornPaper: React.FC<{ w: number; h: number; fill: string; seed?: number; amp?: number; shadow?: boolean; style?: React.CSSProperties; children?: React.ReactNode }> = ({ w, h, fill, seed = 3, amp = 4, shadow = true, style, children }) => (
  <div style={{ position: "relative", width: w, height: h, ...style }}>
    <svg width={w + 20} height={h + 20} viewBox={`-10 -10 ${w + 20} ${h + 20}`} style={{ position: "absolute", left: -10, top: -10, overflow: "visible", filter: shadow ? "drop-shadow(0 6px 10px rgba(0,0,0,0.28))" : undefined }}>
      <polygon points={tornRect(w, h, seed, amp)} fill={fill} />
    </svg>
    <div style={{ position: "absolute", inset: 0 }}>{children}</div>
  </div>
);
