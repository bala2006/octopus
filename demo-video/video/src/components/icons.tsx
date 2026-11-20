import React from "react";
import { Img, staticFile } from "remotion";
import { C, FONT } from "../theme";
import { TornPaper } from "./base";

/** Simple line icons drawn in ink. */
export const Icon: React.FC<{ name: "code" | "palette" | "search" | "cursor" | "check" | "folder" | "chat" | "lock" | "terminal" | "person"; size?: number; color?: string }> = ({ name, size = 64, color = C.ink }) => {
  const p = { fill: "none", stroke: color, strokeWidth: 2.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const body: Record<string, React.ReactNode> = {
    code: <><path d="M9 7 L3 12 L9 17" {...p} /><path d="M15 7 L21 12 L15 17" {...p} /><path d="M13.5 4.5 L10.5 19.5" {...p} /></>,
    palette: <><path d="M12 3a9 9 0 1 0 0 18c1.3 0 2-1 1.4-2.1-.6-1.2.2-2.4 1.5-2.4H17a4 4 0 0 0 4-4C21 6.9 17 3 12 3z" {...p} /><circle cx="7.5" cy="11" r="1.2" fill={color} /><circle cx="10.5" cy="7.5" r="1.2" fill={color} /><circle cx="15" cy="7.5" r="1.2" fill={color} /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" {...p} /><path d="M15.5 15.5 L21 21" {...p} /></>,
    cursor: <path d="M5 3 L12 20 L14.3 13.3 L21 11 Z" {...p} />,
    check: <><rect x="3.5" y="3.5" width="17" height="17" rx="3" {...p} /><path d="M7.5 12.5 L10.5 15.5 L16.5 8.5" {...p} /></>,
    folder: <path d="M3 7 a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" {...p} />,
    chat: <path d="M4 5h16v10H9l-5 4z" {...p} />,
    lock: <><rect x="5" y="10.5" width="14" height="10" rx="2" {...p} /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" {...p} /></>,
    terminal: <><rect x="3" y="4" width="18" height="16" rx="2" {...p} /><path d="M7 9 L10 12 L7 15" {...p} /><path d="M12 15 H17" {...p} /></>,
    person: <><circle cx="12" cy="8" r="4" {...p} /><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" {...p} /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24">{body[name]}</svg>;
};

/** Manila folder cutout. */
export const FolderArt: React.FC<{ w: number }> = ({ w }) => {
  const h = w * 0.74;
  return (
    <svg width={w} height={h} viewBox="0 0 200 148" style={{ filter: "drop-shadow(0 10px 14px rgba(0,0,0,0.3))" }}>
      <path d="M8 22 Q8 12 18 12 H72 L86 28 H182 Q192 28 192 38 V136 Q192 146 182 146 H18 Q8 146 8 136 Z" fill="#C99A4E" />
      <path d="M8 46 Q8 38 16 38 H184 Q192 38 192 46 V136 Q192 146 182 146 H18 Q8 146 8 136 Z" fill="#E2B866" />
      <path d="M18 56 H182" stroke="#C99A4E" strokeWidth="2" opacity="0.6" />
    </svg>
  );
};

export const Logo: React.FC<{ size: number }> = ({ size }) => <Img src={staticFile("shots/logo-mark.svg")} style={{ width: size, height: size }} />;

/** A torn paper card with an icon, a title and a sub line. */
export const RoleCard: React.FC<{ icon: React.ComponentProps<typeof Icon>["name"]; title: string; sub?: string; w?: number; h?: number; seed?: number; accent?: string; num?: string }> = ({ icon, title, sub, w = 300, h = 210, seed = 4, accent = C.ink, num }) => (
  <TornPaper w={w} h={h} fill={C.card} seed={seed} amp={4}>
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 16, textAlign: "center" }}>
      {num && <div style={{ position: "absolute", left: 16, top: 12, fontFamily: FONT.number, fontSize: 30, color: C.red }}>{num}</div>}
      <Icon name={icon} size={h * 0.32} color={accent} />
      <div style={{ fontFamily: FONT.number, fontSize: Math.min(40, w * 0.12), color: C.ink, lineHeight: 1.05 }}>{title}</div>
      {sub && <div style={{ fontFamily: FONT.typewriter, fontWeight: 700, fontSize: 16, letterSpacing: "0.1em", color: C.grey }}>{sub}</div>}
    </div>
  </TornPaper>
);

/** Chai glass cutout drawn in SVG. */
export const ChaiGlass: React.FC<{ w: number }> = ({ w }) => (
  <svg width={w} height={w * 1.25} viewBox="0 0 160 200" style={{ filter: "drop-shadow(0 10px 14px rgba(0,0,0,0.3))" }}>
    <path d="M58 30 q-8 -12 0 -24" stroke="#BDB5AA" strokeWidth="4" fill="none" strokeLinecap="round" />
    <path d="M80 28 q-8 -12 0 -24" stroke="#BDB5AA" strokeWidth="4" fill="none" strokeLinecap="round" />
    <path d="M102 30 q-8 -12 0 -24" stroke="#BDB5AA" strokeWidth="4" fill="none" strokeLinecap="round" />
    <path d="M30 44 H130 L118 182 Q117 192 106 192 H54 Q43 192 42 182 Z" fill="#F7F3EB" opacity="0.92" />
    <path d="M36 70 H124 L117 180 Q116 188 106 188 H54 Q44 188 43 180 Z" fill="#B5652A" />
    <path d="M36 70 H124 L122 88 H38 Z" fill="#D9992F" />
    <path d="M30 44 H130 L118 182 Q117 192 106 192 H54 Q43 192 42 182 Z" fill="none" stroke="#171310" strokeWidth="3" />
    <path d="M52 80 L58 176" stroke="#fff" strokeWidth="5" opacity="0.35" strokeLinecap="round" />
  </svg>
);
