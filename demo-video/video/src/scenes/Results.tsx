import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import { C, FONT } from "../theme";
import { ease, kf, prog } from "../lib";
import { LE, LS, SCENE_FROM, W } from "../time";
import { Headline, Kicker, Label, Life, Pop, TornPaper } from "../components/base";
import { Highlight, MarkerBox, MarkerCircle, Stamp, Tag } from "../components/marks";
import { Footage, RunBadge, ScreenBox, Shot } from "../components/ScreenBox";
import { Icon } from "../components/icons";

type Pair = [number, number];

/* ---------------------------------------------------------------- OUTPUT */
export const Output: React.FC = () => {
  const g = useCurrentFrame();
  const s = "output";
  const from = SCENE_FROM(s);
  const boxAt = LS(s, 1, -8);
  const siteAt = LS(s, 3, -4);
  const phoneAt = LS(s, 7, -6);
  const map: Pair[] = [[siteAt, 0.4], [W(s, "cutting", 1, -6), 3.2], [W(s, "three", 1, -6), 5.6], [W(s, "ginger", 1, 4), 10.6], [W(s, "right"), 12.2]];
  const cams = [
    { f: boxAt, cx: 960, cy: 540, z: 1 },
    { f: W(s, "glass", 1, -10), cx: 960, cy: 540, z: 1 },
    { f: W(s, "glass", 1, 10), cx: 1120, cy: 470, z: 1.5 },
    { f: siteAt - 4, cx: 1120, cy: 470, z: 1.5 },
    { f: siteAt + 4, cx: 960, cy: 540, z: 1 },
    { f: W(s, "eighty", 1, -12), cx: 960, cy: 540, z: 1 },
    { f: W(s, "eighty", 1, 4), cx: 1450, cy: 230, z: 1.7 },
    { f: W(s, "contact", 1, -6), cx: 1450, cy: 230, z: 1.7 },
    { f: W(s, "contact", 1, 12), cx: 1250, cy: 760, z: 1.45 },
  ];
  const phoneScroll = kf(g, [phoneAt + 14, LE(s, 7, 40)], [0, -1650], ease.inOut);
  return (
    <AbsoluteFill>
      <Life at={0} exit={boxAt + 2}>
        <Headline scene={s} text="So, what ==came out?==" at={LS(s, 0)} y={380} size={130} />
      </Life>
      <Kicker text="THE RESULT · OPENED AFTER THE RUN, UNTOUCHED" at={boxAt + 6} y={40} size={24} />
      <ScreenBox at={boxAt} x={200} y={112} w={1520} light url="localhost:4175 · Chai Tapri — a little pause in Bengaluru" cams={cams}
        moveTo={{ f: phoneAt, x: 70, y: 190, w: 1080, dur: 18 }} badge={(gg) => <RunBadge g={gg} clock="THE TEAM'S OUTPUT" />}>
        <Shot src="30-site-hero.png" to={siteAt + 6} />
        <Footage src="site" map={map} from={siteAt} maxSec={12.4} />
        <MarkerCircle at={W(s, "eighty")} box={[1556, 182, 118, 58]} color={C.red} width={6} />
        <Highlight at={W(s, "hours")} box={[1292, 742, 405, 135]} />
      </ScreenBox>
      <Life at={0} exit={LS(s, 4, -2)}>
        <Tag at={W(s, "css")} x={1300} y={860} text="DRAWN IN CSS · NO IMAGE FILES" color="yellow" size={34} rotate={-3} />
      </Life>
      <Life at={0} exit={W(s, "contact", 1, -4)}>
        <Tag at={W(s, "eighty", 1, 6)} x={1380} y={150} text="3 × ₹15 + 2 × ₹20 = ₹85" color="white" size={34} rotate={3} />
      </Life>
      <Life at={phoneAt}>
        <div style={{ position: "absolute", left: 1290, top: 70, width: 440, height: 920, borderRadius: 60, background: "#141312", boxShadow: "0 24px 40px rgba(0,0,0,0.4)", transform: `translateY(${kf(g - phoneAt, [0, 16], [1100, 0], ease.out)}px) rotate(${kf(g - phoneAt, [0, 16], [8, 2], ease.out)}deg)` }}>
          <div style={{ position: "absolute", left: 20, top: 24, width: 400, height: 872, borderRadius: 42, overflow: "hidden", background: "#F4E7D0" }}>
            <Img src={staticFile("shots/35-mobile-full.png")} style={{ width: 400, position: "absolute", top: phoneScroll, left: 0 }} />
          </div>
          <div style={{ position: "absolute", left: 170, top: 34, width: 100, height: 26, borderRadius: 20, background: "#141312" }} />
        </div>
        <Label text="390 px phone" at={phoneAt + 18} x={1510} y={1010} align="center" size={20} />
      </Life>
    </AbsoluteFill>
  );
};

/* ---------------------------------------------------------------- SAFETY */
const TermLine: React.FC<{ at: number; cmd: string; verdict: string; ok?: boolean }> = ({ at, cmd, verdict, ok }) => {
  const g = useCurrentFrame();
  if (g < at) return null;
  const n = Math.min(cmd.length, Math.floor((g - at) * 1.6) + 1);
  const done = n >= cmd.length;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontFamily: FONT.typewriter, fontSize: 34, color: "#E8E3DA", marginBottom: 26 }}>
      <span><span style={{ color: "#8A847D" }}>$ </span>{cmd.slice(0, n)}{!done && <span style={{ display: "inline-block", width: 18, height: 34, marginLeft: 4, verticalAlign: "-5px", background: "#E8E3DA", opacity: Math.floor(g / 8) % 2 }} />}</span>
      {done && <span style={{ fontFamily: FONT.number, fontSize: 34, letterSpacing: "0.04em", color: ok ? "#9BC27A" : "#FF5A4E", border: `3px solid ${ok ? "#9BC27A" : "#FF5A4E"}`, padding: "0 12px", borderRadius: 4, transform: `scale(${kf(g - at - cmd.length / 1.6, [0, 2, 4], [1.6, 0.95, 1])})` }}>{verdict}</span>}
    </div>
  );
};

export const Safety: React.FC = () => {
  const s = "safety";
  const from = SCENE_FROM(s);
  const boxAt = LS(s, 1, -10);
  const termAt = LS(s, 2, -6);
  const map: Pair[] = [[boxAt, 45.6], [W(s, "changes"), 47.6], [W(s, "revert", 1, -6), 48.6], [LE(s, 1, 10), 51.5]];
  const cams = [
    { f: boxAt, cx: 960, cy: 540, z: 1 },
    { f: W(s, "versioned", 1, -4), cx: 960, cy: 540, z: 1 },
    { f: W(s, "versioned", 1, 14), cx: 1500, cy: 360, z: 1.7 },
    { f: W(s, "revert", 1, -4), cx: 1500, cy: 360, z: 1.7 },
    { f: W(s, "revert", 1, 12), cx: 1560, cy: 900, z: 1.8 },
  ];
  return (
    <AbsoluteFill>
      <Kicker text="SAFE IN YOUR REAL FOLDER" at={from + 18} y={40} size={24} />
      <Life at={0} exit={W(s, "server", 1, -12)}>
        <Headline scene={s} text="These agents work in / ==your real folder.==" at={W(s, "these", 1, -2)} y={340} size={92} />
      </Life>
      <Life at={W(s, "server", 1, -8)} exit={boxAt + 2}>
        <Headline scene={s} text="The server enforces the limits, / ==not the model.==" at={W(s, "server", 1, -8)} y={340} size={92} />
      </Life>
      <ScreenBox at={boxAt} x={200} y={112} w={1520} cams={cams} moveTo={{ f: termAt, x: 70, y: 260, w: 860, dur: 16 }} badge={(g) => <RunBadge g={g} clock="CHANGES VIEW" />}>
        <Footage src="tour" map={map} />
        <MarkerBox at={W(s, "versioned", 1, 10)} box={[1573, 258, 330, 120]} color={C.yellow} />
        <MarkerCircle at={W(s, "click")} box={[1579, 1021, 320, 34]} color={C.red} />
      </ScreenBox>
      <Life at={termAt}>
        <Pop at={termAt} x={990} y={230} rotate={1}>
          <div style={{ width: 860, height: 560, borderRadius: 14, background: "#151413", boxShadow: "0 20px 34px rgba(0,0,0,0.4)", overflow: "hidden" }}>
            <div style={{ height: 44, background: "#2A2927", display: "flex", alignItems: "center", padding: "0 18px", gap: 10 }}>
              {["#FF5F57", "#FEBC2E", "#28C840"].map((c) => <div key={c} style={{ width: 14, height: 14, borderRadius: 9, background: c }} />)}
              <div style={{ marginLeft: 20, fontFamily: FONT.typewriter, fontWeight: 700, fontSize: 17, color: "#B9B4AC", letterSpacing: "0.1em" }}>AGENT COMMANDS · CHECKED FIRST · NO KEYS</div>
            </div>
            <div style={{ padding: "34px 36px" }}>
              <TermLine at={W(s, "commands")} cmd="npm test" verdict="RUNS" ok />
              <TermLine at={W(s, "keys")} cmd="echo $AZURE_API_KEY" verdict="EMPTY" ok />
              <TermLine at={W(s, "dangerous")} cmd="rm -rf src" verdict="REFUSED" />
              <TermLine at={W(s, "reset")} cmd="git reset --hard" verdict="REFUSED" />
              <TermLine at={W(s, "refused", 1, -8)} cmd="git push --force" verdict="REFUSED" />
            </div>
          </div>
        </Pop>
        <Label text="from Octopus's command policy · server/src/safety/commands.ts" at={W(s, "refused")} x={1420} y={810} align="center" size={17} />
      </Life>
      <Pop at={W(s, "listens")} x={1060} y={880} rotate={-3}>
        <TornPaper w={640} h={100} fill={C.yellow} seed={19}>
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 18, fontFamily: FONT.number, fontSize: 44 }}><Icon name="lock" size={50} />LISTENS ON 127.0.0.1 ONLY</div>
        </TornPaper>
      </Pop>
    </AbsoluteFill>
  );
};

/* ---------------------------------------------------------------- HONEST */
export const Honest: React.FC = () => {
  const g = useCurrentFrame();
  const s = "honest";
  const from = SCENE_FROM(s);
  const scroll = kf(g, [LS(s, 1, -10), LE(s, 1, 10)], [-760, -1040], ease.inOut);
  return (
    <AbsoluteFill>
      <Kicker text="ONE MORE THING" x={110} at={from + 18} y={60} size={24} />
      <Headline scene={s} text="Octopus / ==does not pretend.==" at={W(s, "octopus")} y={130} x={110} align="left" size={84} width={800} />
      <Headline scene={s} text="You always see / **what actually happened.**" at={LS(s, 2)} y={640} x={110} align="left" size={60} width={800} />
      <Pop at={LS(s, 0, 10)} x={900} y={110} rotate={1.2}>
        <TornPaper w={960} h={820} fill="#1C1B1A" seed={88} amp={5}>
          <div style={{ position: "absolute", left: 10, top: 20, right: 10, bottom: 20, overflow: "hidden" }}>
            <div style={{ position: "absolute", left: 0, top: scroll }}>
              <Img src={staticFile("shots/report-card.png")} style={{ width: 941, display: "block" }} />
              <Highlight at={W(s, "open")} box={[0, 1448, 941, 340]} />
            </div>
          </div>
        </TornPaper>
      </Pop>
      <Tag at={W(s, "open")} x={1440} y={70} text="STILL OPEN · 2 TASKS" color="red" size={38} rotate={4} />
      <Tag at={W(s, "says")} x={1000} y={958} text="LISTED RIGHT IN THE REPORT" color="yellow" size={34} rotate={-2} />
    </AbsoluteFill>
  );
};
