import React from "react";
import { useCurrentFrame } from "remotion";
import { C, FONT } from "../theme";
import { ease, kf, prog, rand } from "../lib";
import { TornPaper } from "./base";

const Stroke: React.FC<{ d: string; p: number; color: string; width?: number; opacity?: number }> = ({ d, p, color, width = 6, opacity = 1 }) => (
  <path d={d} pathLength={1} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" strokeDasharray="1 1" strokeDashoffset={1 - p} opacity={opacity} />
);

/** Hand-drawn marker arrow that draws on. Coordinates are in the parent's pixel space. */
export const Arrow: React.FC<{ at: number; from: [number, number]; to: [number, number]; bend?: number; color?: string; width?: number; frames?: number }> = ({ at, from, to, bend = 0.22, color = C.red, width = 6, frames = 9 }) => {
  const g = useCurrentFrame();
  if (g < at) return null;
  const [x1, y1] = from, [x2, y2] = to;
  const mx = (x1 + x2) / 2 - (y2 - y1) * bend, my = (y1 + y2) / 2 + (x2 - x1) * bend;
  const p = prog(g, at, frames, ease.out);
  const ang = Math.atan2(y2 - my, x2 - mx);
  const head = 26;
  const hp = prog(g, at + frames - 1, 3);
  return (
    <svg width={1920} height={1080} style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none" }}>
      <Stroke d={`M${x1} ${y1} Q${mx} ${my} ${x2} ${y2}`} p={p} color={color} width={width} />
      <Stroke d={`M${x2} ${y2} L${x2 - head * Math.cos(ang - 0.5)} ${y2 - head * Math.sin(ang - 0.5)}`} p={hp} color={color} width={width} />
      <Stroke d={`M${x2} ${y2} L${x2 - head * Math.cos(ang + 0.5)} ${y2 - head * Math.sin(ang + 0.5)}`} p={hp} color={color} width={width} />
    </svg>
  );
};

export function circlePath(cx: number, cy: number, rx: number, ry: number, seed = 5) {
  const pts: string[] = [];
  const steps = 56;
  for (let i = 0; i <= steps; i++) {
    const a = -Math.PI / 2 - 0.3 + (i / steps) * Math.PI * 2.14;
    const j = 1 + (rand(seed + Math.floor(i / 7)) - 0.5) * 0.05 + (i / steps) * 0.04;
    pts.push(`${(cx + Math.cos(a) * rx * j).toFixed(1)} ${(cy + Math.sin(a) * ry * j).toFixed(1)}`);
  }
  return "M" + pts.join(" L");
}

/** Red marker ellipse around a box [x, y, w, h]. */
export const MarkerCircle: React.FC<{ at: number; box: [number, number, number, number]; color?: string; width?: number; pad?: number; seed?: number }> = ({ at, box, color = C.red, width = 6, pad = 14, seed = 5 }) => {
  const g = useCurrentFrame();
  if (g < at) return null;
  const [x, y, w, h] = box;
  return (
    <svg width={1920} height={1080} style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none" }}>
      <Stroke d={circlePath(x + w / 2, y + h / 2, w / 2 + pad, h / 2 + pad * 0.9, seed)} p={prog(g, at, 9)} color={color} width={width} />
    </svg>
  );
};

/** Translucent highlighter band over a box (multiply blend so the text stays readable). */
export const Highlight: React.FC<{ at: number; box: [number, number, number, number]; color?: string; exit?: number }> = ({ at, box, color = C.yellow, exit }) => {
  const g = useCurrentFrame();
  if (g < at) return null;
  const [x, y, w, h] = box;
  const p = prog(g, at, 7);
  const o = exit !== undefined ? 1 - prog(g, exit, 6) : 1;
  return <div style={{ position: "absolute", left: x - 6, top: y - 3, width: (w + 12) * p, height: h + 6, background: color, opacity: 0.55 * o, mixBlendMode: "multiply", borderRadius: "6px 3px 7px 4px", transform: "rotate(-0.4deg)" }} />;
};

/** Hand-drawn rectangle outline. */
export const MarkerBox: React.FC<{ at: number; box: [number, number, number, number]; color?: string; width?: number; exit?: number }> = ({ at, box, color = C.yellow, width = 5, exit }) => {
  const g = useCurrentFrame();
  if (g < at) return null;
  const [x, y, w, h] = box;
  const j = (i: number) => (rand(i + x) - 0.5) * 6;
  const d = `M${x + j(1)} ${y + j(2)} L${x + w + j(3)} ${y + j(4)} L${x + w + j(5)} ${y + h + j(6)} L${x + j(7)} ${y + h + j(8)} Z`;
  const o = exit !== undefined ? 1 - prog(g, exit, 6) : 1;
  return (
    <svg width={1920} height={1080} style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none", opacity: o }}>
      <Stroke d={d} p={prog(g, at, 10)} color={color} width={width} />
    </svg>
  );
};

export const Strike: React.FC<{ at: number; x1: number; x2: number; y: number; color?: string; width?: number }> = ({ at, x1, x2, y, color = C.red, width = 10 }) => {
  const g = useCurrentFrame();
  if (g < at) return null;
  return (
    <svg width={1920} height={1080} style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}>
      <Stroke d={`M${x1} ${y + 5} Q${(x1 + x2) / 2} ${y - 7} ${x2} ${y - 2}`} p={prog(g, at, 7)} color={color} width={width} />
    </svg>
  );
};

export const Stamp: React.FC<{ at: number; x: number; y: number; text: string; rotate?: number; size?: number; color?: string }> = ({ at, x, y, text, rotate = -9, size = 54, color = C.red }) => {
  const g = useCurrentFrame();
  if (g < at) return null;
  const lt = g - at;
  const s = kf(lt, [0, 2, 3, 5, 8], [2.3, 1.4, 1.05, 0.88, 1.0]);
  return (
    <div style={{ position: "absolute", left: x, top: y, transform: `translate(-50%, -50%) scale(${s}) rotate(${rotate}deg)`, opacity: kf(lt, [0, 3], [0.3, 0.95]), zIndex: 20 }}>
      <div style={{ border: `5px solid ${color}`, borderRadius: 8, padding: "2px 18px", fontFamily: FONT.number, fontSize: size, color, letterSpacing: "0.04em", background: "rgba(247,243,235,0.72)", whiteSpace: "nowrap", maskImage: "radial-gradient(circle at 30% 40%, #000 60%, rgba(0,0,0,0.78) 100%)" }}>{text}</div>
    </div>
  );
};

export const Tag: React.FC<{ at: number; x: number; y: number; text: React.ReactNode; color?: "yellow" | "white" | "red" | "ink"; size?: number; rotate?: number; font?: "number" | "typewriter" | "ui" }> = ({ at, x, y, text, color = "yellow", size = 34, rotate = -4, font = "number" }) => {
  const g = useCurrentFrame();
  if (g < at) return null;
  const lt = g - at;
  const bg = color === "yellow" ? C.yellow : color === "white" ? C.tag : color === "red" ? C.red : C.ink;
  const fg = color === "red" || color === "ink" ? "#fff" : C.ink;
  const s = kf(lt, [0, 2, 4], [1.35, 1.03, 1.0], ease.out);
  return (
    <div style={{ position: "absolute", left: x, top: y, transform: `scale(${s}) rotate(${rotate}deg)`, opacity: lt < 1 ? 0.6 : 1, zIndex: 15 }}>
      <div style={{ background: bg, color: fg, fontFamily: FONT[font], fontWeight: font === "number" ? 400 : 700, letterSpacing: font === "typewriter" ? "0.1em" : undefined, fontSize: size, lineHeight: 1.12, padding: `${size * 0.14}px ${size * 0.32}px`, border: color === "yellow" || color === "white" ? `2.5px solid ${C.ink}` : undefined, borderRadius: 3, boxShadow: "0 5px 10px rgba(0,0,0,0.28)", whiteSpace: "nowrap" }}>{text}</div>
    </div>
  );
};

/** Red torn-paper sticker for a payoff. */
export const Sticker: React.FC<{ at: number; x: number; y: number; top?: string; main: string; w?: number; rotate?: number; color?: string; size?: number }> = ({ at, x, y, top, main, w = 520, rotate = -2.5, color = C.red, size = 72 }) => {
  const g = useCurrentFrame();
  if (g < at) return null;
  const lt = g - at;
  const h = top ? size * 2 + 6 : size * 1.55;
  const scale = kf(lt, [0, 2, 4, 5, 7], [0.7, 0.85, 0.98, 1.05, 1.0]);
  const rot = kf(lt, [0, 2, 4, 7], [-12, -8, -4, rotate]);
  return (
    <div style={{ position: "absolute", left: x, top: y, transform: `scale(${scale}) rotate(${rot}deg)`, zIndex: 18 }}>
      <TornPaper w={w} h={h} fill={color} seed={11} amp={6}>
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#fff" }}>
          {top && <div style={{ fontFamily: FONT.typewriter, fontWeight: 700, fontSize: size * 0.28, letterSpacing: "0.16em" }}>{top}</div>}
          <div style={{ fontFamily: FONT.number, fontSize: size, lineHeight: 1.05 }}>{main}</div>
        </div>
      </TornPaper>
    </div>
  );
};

export const Badge: React.FC<{ at: number; x: number; y: number; text: string; size?: number; color?: string }> = ({ at, x, y, text, size = 80, color = C.red }) => {
  const g = useCurrentFrame();
  if (g < at) return null;
  const s = kf(g - at, [0, 2, 4, 6], [0.2, 1.25, 0.95, 1.0]);
  return <div style={{ position: "absolute", left: x - size / 2, top: y - size / 2, width: size, height: size, borderRadius: size, background: color, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.number, fontSize: size * 0.48, transform: `scale(${s})`, boxShadow: "0 4px 10px rgba(0,0,0,0.3)", zIndex: 25 }}>{text}</div>;
};

/** A strip of masking tape. */
export const Tape: React.FC<{ x: number; y: number; w?: number; rotate?: number }> = ({ x, y, w = 150, rotate = -8 }) => (
  <div style={{ position: "absolute", left: x, top: y, width: w, height: 40, transform: `rotate(${rotate}deg)`, background: "rgba(232,222,196,0.82)", boxShadow: "0 2px 4px rgba(0,0,0,0.12)", clipPath: "polygon(2% 8%, 98% 0, 100% 50%, 97% 100%, 3% 92%, 0 50%)", zIndex: 30 }} />
);
