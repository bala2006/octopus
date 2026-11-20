import React from "react";
import { Easing, interpolate, staticFile } from "remotion";


export const ease = {
  out: Easing.bezier(0.22, 1, 0.36, 1),
  inOut: Easing.bezier(0.65, 0, 0.35, 1),
  in: Easing.bezier(0.55, 0, 1, 0.45),
  linear: (x: number) => x,
};

/** 0..1 progress of t over [start, start + dur]. */
export function prog(t: number, start: number, dur: number, e: (x: number) => number = ease.out) {
  if (dur <= 0) return t >= start ? 1 : 0;
  return interpolate(t, [start, start + dur], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: e });
}

/** Piecewise keyframes, clamped. */
export function kf(t: number, times: number[], values: number[], e: (x: number) => number = ease.linear) {
  return interpolate(t, times, values, { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: e });
}

export const lerp = (a: number, b: number, p: number) => a + (b - a) * p;


/** Deterministic pseudo-random in [0,1). */
export function rand(seed: number) {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Jagged polygon points for a torn-paper rectangle. */
export function tornRect(w: number, h: number, seed = 1, amp = 5, step = 14, sides = { t: true, r: true, b: true, l: true }) {
  const pts: string[] = [];
  const j = (i: number, on: boolean) => (on ? (rand(seed + i) - 0.5) * 2 * amp : 0);
  let i = 0;
  for (let x = 0; x < w; x += step) pts.push(`${x},${j(i++, sides.t)}`);
  for (let y = 0; y < h; y += step) pts.push(`${w + j(i++, sides.r)},${y}`);
  for (let x = w; x > 0; x -= step) pts.push(`${x},${h + j(i++, sides.b)}`);
  for (let y = h; y > 0; y -= step) pts.push(`${j(i++, sides.l)},${y}`);
  return pts.join(" ");
}

export const TornPaper: React.FC<{ w: number; h: number; fill: string; seed?: number; amp?: number; stroke?: string; shadow?: boolean; style?: React.CSSProperties; children?: React.ReactNode }> = ({ w, h, fill, seed = 3, amp = 4, stroke, shadow = true, style, children }) => (
  <div style={{ position: "absolute", width: w, height: h, ...style }}>
    <svg width={w + 20} height={h + 20} viewBox={`-10 -10 ${w + 20} ${h + 20}`} style={{ position: "absolute", left: -10, top: -10, overflow: "visible", filter: shadow ? "drop-shadow(0 6px 10px rgba(0,0,0,0.28))" : undefined }}>
      <polygon points={tornRect(w, h, seed, amp)} fill={fill} stroke={stroke} strokeWidth={stroke ? 2.5 : 0} strokeLinejoin="round" />
    </svg>
    <div style={{ position: "absolute", inset: 0 }}>{children}</div>
  </div>
);

export const assetSrc = (src: string) => (/^(https?:|data:|blob:)/.test(src) ? src : staticFile(src));

export const fmtMoney = (v: number, prefix = "$") => prefix + Math.floor(v).toLocaleString("en-US");
