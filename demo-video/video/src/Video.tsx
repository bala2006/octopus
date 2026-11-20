import React from "react";
import { AbsoluteFill, Html5Audio, Sequence, staticFile, useCurrentFrame } from "remotion";
import { ease, prog, rand } from "./lib";
import { DURATION, PUSH, windows } from "./time";
import { PaperBackground } from "./components/base";
import { Close, Hook, Idea, Numbers, Problem } from "./scenes/Explainers";
import { Build, Prompt, Review, Setup, Staff, Verify } from "./scenes/Screens";
import { Honest, Output, Safety } from "./scenes/Results";

const SCENES: Record<string, { C: React.FC; dark?: boolean; push: "right" | "bottom" }> = {
  hook: { C: Hook, push: "bottom" },
  problem: { C: Problem, push: "right" },
  idea: { C: Idea, push: "bottom" },
  setup: { C: Setup, push: "right" },
  prompt: { C: Prompt, push: "bottom" },
  staff: { C: Staff, push: "right" },
  build: { C: Build, push: "bottom" },
  review: { C: Review, push: "right" },
  verify: { C: Verify, push: "bottom" },
  numbers: { C: Numbers, push: "right" },
  output: { C: Output, push: "bottom" },
  safety: { C: Safety, push: "right" },
  honest: { C: Honest, push: "bottom" },
  close: { C: Close, push: "bottom", dark: true },
};

function tornEdge(dir: "right" | "bottom", inset = 0) {
  const pts: string[] = [];
  const amp = 8;
  if (dir === "right") {
    for (let y = 0; y <= 1080; y += 16) pts.push(`${(rand(y) * amp + inset).toFixed(1)}px ${y}px`);
    pts.push("1960px 1080px", "1960px 0px");
  } else {
    for (let x = 1920; x >= 0; x -= 16) pts.push(`${x}px ${(rand(x + 3) * amp + inset).toFixed(1)}px`);
    pts.push("0px 1120px", "1920px 1120px");
  }
  return `polygon(${pts.join(", ")})`;
}

/** A page: slides in over the previous one with a torn edge, and blurs as the next page covers it. */
const Page: React.FC<{ from: number; to: number; first: boolean; dir: "right" | "bottom"; dark?: boolean; children: React.ReactNode }> = ({ from, to, first, dir, dark, children }) => {
  const g = useCurrentFrame();
  const lt = g - from;
  const content = (
    <AbsoluteFill>
      <PaperBackground dark={dark} />
      {children}
    </AbsoluteFill>
  );
  let page: React.ReactNode = content;
  if (!first && lt < PUSH) {
    const p = prog(lt, 0, PUSH, ease.inOut);
    const off = (1 - p) * (dir === "right" ? 1960 : 1120);
    const transform = dir === "right" ? `translateX(${off}px)` : `translateY(${off}px)`;
    page = (
      <AbsoluteFill style={{ transform, filter: "drop-shadow(0 0 18px rgba(0,0,0,0.45))" }}>
        <AbsoluteFill style={{ background: dark ? "#3A3632" : "#FFFFFF", clipPath: tornEdge(dir, -7) }} />
        <AbsoluteFill style={{ clipPath: tornEdge(dir, 0) }}>{content}</AbsoluteFill>
      </AbsoluteFill>
    );
  }
  const leaving = to - g;
  if (leaving < PUSH + 2) {
    const p = prog(g, to - PUSH - 2, PUSH, ease.in);
    page = <AbsoluteFill style={{ filter: `blur(${p * 12}px) brightness(${1 - p * 0.25})` }}>{page}</AbsoluteFill>;
  }
  return <AbsoluteFill>{page}</AbsoluteFill>;
};

export const OctopusDemo: React.FC = () => {
  const g = useCurrentFrame();
  const ws = windows();
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      {ws.map((w) => {
        if (g < w.from || g >= w.to) return null;
        const sc = SCENES[w.id];
        const C = sc.C;
        return (
          <Page key={w.id} from={w.from} to={w.index === ws.length - 1 ? DURATION + 100 : w.to} first={w.index === 0} dir={sc.push} dark={sc.dark}>
            <C />
          </Page>
        );
      })}
      <Sequence from={0} layout="none"><Html5Audio src={staticFile("audio/mix.wav")} /></Sequence>
      {/* fade from / to black */}
      <AbsoluteFill style={{ background: "#000", opacity: Math.max(1 - prog(g, 0, 12), prog(g, DURATION - 24, 22)), pointerEvents: "none" }} />
    </AbsoluteFill>
  );
};
