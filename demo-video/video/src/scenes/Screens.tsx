import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import { C, FONT } from "../theme";
import { ease, kf, prog } from "../lib";
import { LE, LS, SCENE_FROM, W } from "../time";
import { Headline, Kicker, Label, Life, Pop, TornPaper } from "../components/base";
import { Arrow, Badge, Highlight, MarkerBox, MarkerCircle, Stamp, Sticker, Tag } from "../components/marks";
import { Footage, RunBadge, ScreenBox, Shot, remap, runClock } from "../components/ScreenBox";
import { Icon, Logo } from "../components/icons";

// Recording streams. "main" shows the Canvas tab with the floating chat; "chatview" shows the full Chat tab.
// Times below are seconds since the capture started (marks.json); each stream has its own offset.
const OFF = { main: 0, chatview: 52.46 } as const;
const at = (stream: keyof typeof OFF, rel: number) => rel - OFF[stream];
const STREAM_FILE = { main: "main", chatview: "canvas" } as const;
type Pair = [number, number];
const mapRel = (stream: keyof typeof OFF, pairs: Pair[]): Pair[] => pairs.map(([f, r]) => [f, at(stream, r)]);

const BOX = { x: 200, y: 112, w: 1520 };

/** Opaque, blurred-looking cover for private details in the footage (source pixel space). */
const Redact: React.FC<{ box: [number, number, number, number]; from?: number }> = ({ box: [x, y, w, h], from = -1e9 }) => {
  const g = useCurrentFrame();
  if (g < from) return null;
  return (
    <div style={{ position: "absolute", left: x, top: y, width: w, height: h, borderRadius: 6, background: "repeating-linear-gradient(90deg, #3a3835 0 14px, #34322f 14px 22px)", filter: "blur(1.5px)", opacity: prog(g, from, 4) }} />
  );
};


/** Full cover over the Azure form while the endpoint is on screen. Source pixel space, so it follows the camera. */
const FormCover: React.FC<{ from: number; until: number }> = ({ from, until }) => {
  const g = useCurrentFrame();
  if (g < from || g >= until) return null;
  const o = Math.min(prog(g, from, 4), 1 - prog(g, until - 6, 5));
  return (
    <div style={{ position: "absolute", left: 830, top: 280, width: 1080, height: 720, borderRadius: 8, background: "#1d1c1b", opacity: o }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", background: "repeating-linear-gradient(90deg, #2a2927 0 16px, #262523 16px 32px)", filter: "blur(2px)" }} />
    </div>
  );
};

/* ----------------------------------------------------------------- SETUP */
export const Setup: React.FC = () => {
  const s = "setup";
  const from = SCENE_FROM(s);
  const map: Pair[] = [[from, 3.6], [W(s, "paste", 1, -4), 5.0], [W(s, "key", 1, -2), 9.4], [W(s, "save"), 11.2], [W(s, "test", 1, -4), 11.6], [W(s, "connected", 1, -2), 14.0], [LE(s, 3), 15.5]];
  const cams = [
    { f: from, cx: 960, cy: 540, z: 1 },
    { f: W(s, "paste", 1, -12), cx: 960, cy: 540, z: 1 },
    { f: W(s, "paste", 1, 6), cx: 1380, cy: 520, z: 1.75 },
    { f: W(s, "key"), cx: 1380, cy: 640, z: 1.75 },
    { f: W(s, "save", 1, 4), cx: 1180, cy: 900, z: 1.75 },
    { f: W(s, "seconds", 1, 12), cx: 1250, cy: 900, z: 1.75 },
    { f: W(s, "encrypted", 1, -6), cx: 1230, cy: 300, z: 1.7 },
  ];
  return (
    <AbsoluteFill>
      <Kicker text="STEP 1 · CONNECT THE MODEL" at={from + 18} y={40} size={24} />
      <ScreenBox at={from + 6} {...BOX} cams={cams} badge={(g) => <RunBadge g={g} clock="LIVE · 1×" />}>
        <Footage src="main" map={map} maxSec={16.5} />
        {/* The endpoint (resource name) stays on screen to the end of this scene, so the cover runs until the scene unmounts. */}
        <FormCover from={W(s, "paste", 1, -4)} until={1e9} />
        <Redact box={[938, 604, 108, 30]} from={W(s, "save")} />
        <Highlight at={W(s, "paste", 1, 8)} box={[899, 482, 970, 46]} exit={W(s, "key")} />
        <Highlight at={W(s, "key", 1, 4)} box={[899, 638, 970, 46]} exit={W(s, "save")} />
        <MarkerCircle at={W(s, "connected")} box={[1125, 932, 365, 34]} color={C.yellow} width={7} />
        <MarkerCircle at={W(s, "seconds")} box={[1412, 934, 92, 30]} color={C.red} />
        <Highlight at={W(s, "encrypted")} box={[833, 208, 800, 60]} />
      </ScreenBox>
      <Tag at={W(s, "connected", 1, 6)} x={1380} y={980} text="CONNECTED · gpt-6-luna · 1.9 s" color="yellow" size={34} rotate={-3} />
    </AbsoluteFill>
  );
};

/* ---------------------------------------------------------------- PROMPT */
export const Prompt: React.FC = () => {
  const s = "prompt";
  const from = SCENE_FROM(s);
  const map: Pair[] = [[from, 18.6], [W(s, "request", 1, 10), 21.2], [W(s, "asking"), 22.0], [LE(s, 3), 30.6], [W(s, "empty", 1, -6), 34.4], [W(s, "create", 1, -4), 43.8], [W(s, "send", 1, -2), 46.8], [W(s, "send", 1, 40), 52]];
  const cams = [
    { f: from, cx: 960, cy: 540, z: 1 },
    { f: W(s, "asking", 1, -6), cx: 960, cy: 540, z: 1 },
    { f: W(s, "asking", 1, 14), cx: 1176, cy: 800, z: 1.6 },
    { f: LE(s, 3, -4), cx: 1176, cy: 800, z: 1.6 },
    { f: W(s, "empty", 1, -2), cx: 960, cy: 520, z: 1.3 },
    { f: W(s, "send", 1, -8), cx: 960, cy: 520, z: 1.3 },
    { f: W(s, "send", 1, 10), cx: 960, cy: 540, z: 1 },
  ];
  const asks: [string, string, number, number][] = [
    ["WARM HERO", "hero", 120, -4], ["MENU IN ₹", "menu", 420, 3], ["ORDER COUNTER", "counter", 700, -2], ["CONTACT + HOURS", "contact", 1060, 3], ["RESPONSIVE", "responsive", 1420, -3], ["PLAIN HTML · CSS · JS", "plain", 1250, 2],
  ];
  return (
    <AbsoluteFill>
      <Kicker text="STEP 2 · ASK FOR WHAT YOU WANT" at={from + 18} y={40} size={24} />
      <ScreenBox at={from + 4} {...BOX} cams={cams} badge={(g) => <RunBadge g={g} clock="LIVE · 1×" />}>
        <Footage src="main" map={map} />
        <MarkerBox at={W(s, "empty", 1, 10)} box={[580, 540, 1180, 100]} exit={W(s, "create", 1, -8)} />
        <MarkerCircle at={W(s, "send", 1, -6)} box={[1200, 728, 160, 56]} color={C.yellow} />
      </ScreenBox>
      <Life at={from} exit={W(s, "empty", 1, -10)}>
        {asks.map(([t, w, x, r], i) => <Tag key={t} at={W(s, w)} x={x} y={i === 5 ? 860 : 960} text={t} color={i % 2 ? "white" : "yellow"} size={32} rotate={r} />)}
      </Life>
      <Tag at={W(s, "chai")} x={120} y={150} text="CHAI TAPRI · BENGALURU" color="red" size={36} rotate={-5} />
    </AbsoluteFill>
  );
};

/* ----------------------------------------------------------------- STAFF */
export const Staff: React.FC = () => {
  const g = useCurrentFrame();
  const s = "staff";
  const from = SCENE_FROM(s);
  const canvasAt = LS(s, 3, -4);
  const chatMap = mapRel("chatview", [[from, 54.5], [W(s, "seven", 1, -4), 56.6], [W(s, "hires", 1, -2), 61.0], [W(s, "maya"), 61.6], [canvasAt, 64]]);
  const canvasMap: Pair[] = [[canvasAt, 60], [W(s, "joins"), 150], [LE(s, 3, 10), 300]];
  const rows: [string, number][] = [["maya", 436], ["ira", 563], ["dev", 688]];
  const reqs = ["Landing page for Chai Tapri, Bengaluru", "A warm hero section", "A menu with prices in rupees", "An order counter: add, remove, total", "A contact section with opening hours", "Make it responsive", "Plain HTML, CSS and JavaScript"];
  return (
    <AbsoluteFill>
      <Kicker text="STEP 3 · OCTOPUS STAFFS THE WORK" at={from + 18} y={40} size={24} />
      <ScreenBox at={from + 4} {...BOX} cams={[{ f: from, cx: 820, cy: 500, z: 1.25 }, { f: canvasAt - 2, cx: 820, cy: 560, z: 1.25 }, { f: canvasAt + 2, cx: 960, cy: 540, z: 1 }]}
        badge={(gg) => <RunBadge g={gg} clock={gg < canvasAt ? runClock(remap(gg, chatMap) + OFF.chatview) : runClock(remap(gg, canvasMap))} speed={gg < canvasAt ? "1×" : "TIME-LAPSE 30×"} />}>
        <Footage src={STREAM_FILE.chatview} map={chatMap} to={canvasAt + 6} />
        <Footage src={STREAM_FILE.main} map={canvasMap} from={canvasAt} />
        {rows.map(([w, y]) => <MarkerBox key={w} at={W(s, w)} box={[537, y, 955, 54]} exit={canvasAt} />)}
        <MarkerBox at={W(s, "grouped")} box={[452, 210, 330, 480]} color={C.red} />
        <MarkerCircle at={W(s, "builds", 1, 4)} box={[1120, 133, 220, 187]} color={C.yellow} />
      </ScreenBox>
      <Life at={W(s, "seven", 1, -4)} exit={W(s, "hires", 1, -2)}>
        <Pop at={W(s, "seven", 1, -4)} x={1120} y={230} rotate={2} z={30}>
          <TornPaper w={640} h={560} fill={C.card} seed={44}>
            <div style={{ padding: "26px 34px" }}>
              <div style={{ fontFamily: FONT.typewriter, fontWeight: 700, fontSize: 20, letterSpacing: "0.14em", color: C.red }}>SET_REQUIREMENTS · 7 ITEMS</div>
              {reqs.map((r, i) => (
                <div key={r} style={{ display: "flex", gap: 16, marginTop: 16, fontFamily: FONT.ui, fontSize: 25, color: C.ink, opacity: prog(g, W(s, "seven", 1, i * 2), 4) }}>
                  <span style={{ fontFamily: FONT.number, color: C.red, width: 40 }}>R{i + 1}</span>{r}
                </div>
              ))}
            </div>
          </TornPaper>
        </Pop>
      </Life>
      <Life at={W(s, "words")} exit={W(s, "hires", 1, -2)}>
        <Tag at={W(s, "words")} x={1300} y={800} text="IN MY OWN WORDS" color="yellow" size={38} rotate={-3} />
      </Life>
      <Life at={W(s, "maya")} exit={canvasAt}>
        <Tag at={W(s, "maya")} x={1620} y={478} text="FRONTEND" color="white" size={28} rotate={4} />
        <Tag at={W(s, "ira")} x={1620} y={603} text="DESIGN" color="white" size={28} rotate={-3} />
        <Tag at={W(s, "dev")} x={1620} y={728} text="QA" color="white" size={28} rotate={3} />
      </Life>
    </AbsoluteFill>
  );
};

/* ----------------------------------------------------------------- BUILD */
export const Build: React.FC = () => {
  const g = useCurrentFrame();
  const s = "build";
  const from = SCENE_FROM(s);
  const map: Pair[] = [[from, 76], [W(s, "html", 1, -4), 123.8], [W(s, "styles", 1, -4), 169.3], [W(s, "script", 1, -4), 177.9], [W(s, "checks", 1, -4), 184.1], [W(s, "server", 1, -4), 195.1], [W(s, "browser", 1, -4), 200.8], [W(s, "clicks", 1, -4), 212.5], [W(s, "resizes", 1, -4), 253.6], [W(s, "done", 1, -2), 283.9], [W(s, "done", 1, 30), 286]];
  const steps: [string, string, string][] = [
    ["write_file", "index.html", "html"], ["write_file", "styles.css", "styles"], ["write_file", "script.js", "script"],
    ["shell", "node --check script.js", "checks"], ["shell", "python3 -m http.server 4173", "server"], ["browser", "navigate localhost:4173", "browser"],
    ["browser", "click  +  /  −   × 7", "clicks"], ["browser", "resize 1280 × 800", "resizes"], ["complete_task", "“Built the Chai Tapri page…”", "done"],
  ];
  return (
    <AbsoluteFill>
      <Kicker text="STEP 4 · BUILD" x={90} at={from + 18} y={46} size={24} />
      <Headline scene={s} text="Maya ==owns the page.==" at={LS(s, 0)} y={86} x={90} align="left" size={62} width={720} />
      <ScreenBox at={from + 4} x={690} y={150} w={1160} rotate={0.6} enterFrom="right" cams={[{ f: from, cx: 1300, cy: 520, z: 1.45 }, { f: W(s, "done"), cx: 1300, cy: 520, z: 1.45 }]}
        badge={(gg) => <RunBadge g={gg} clock={runClock(remap(gg, map))} speed="TIME-LAPSE" size={13} />}>
        <Footage src="main" map={map} />
      </ScreenBox>
      <div style={{ position: "absolute", left: 90, top: 210 }}>
        {steps.map(([tool, arg, w], i) => {
          const a = W(s, w);
          if (g < a) return null;
          const lt = g - a;
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14, transform: `translateX(${kf(lt, [0, 7], [-40, 0], ease.out)}px)`, opacity: prog(g, a, 5) }}>
              <div style={{ width: 34, height: 34, borderRadius: 34, background: i === 8 ? C.red : C.ink, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.number, fontSize: 18 }}>{i + 1}</div>
              <TornPaper w={500} h={60} fill={i === 8 ? C.yellow : "#FFFFFF"} seed={i * 3 + 1} amp={3}>
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", padding: "0 16px", gap: 12, fontFamily: FONT.typewriter, fontSize: 21, color: C.ink, whiteSpace: "nowrap" }}>
                  <b style={{ color: tool === "browser" ? C.red : C.inkSoft }}>{tool}</b><span>{arg}</span>
                </div>
              </TornPaper>
            </div>
          );
        })}
      </div>
      <Pop at={W(s, "browser", 1, 6)} x={1180} y={640} rotate={4} z={40}>
        <div style={{ background: "#fff", padding: "14px 14px 50px", boxShadow: "0 14px 24px rgba(0,0,0,0.35)" }}>
          <Img src={staticFile("shots/maya-browser.jpg")} style={{ width: 560, display: "block" }} />
          <div style={{ position: "absolute", bottom: 12, left: 0, width: "100%", textAlign: "center", fontFamily: FONT.headline, fontStyle: "italic", fontSize: 24, color: C.ink }}>Maya's own screenshot, from her browser</div>
        </div>
      </Pop>
      <Stamp at={W(s, "done", 1, -2)} x={1500} y={260} text="BEFORE SAYING DONE" size={54} rotate={-7} />
    </AbsoluteFill>
  );
};

/* ---------------------------------------------------------------- REVIEW */
export const Review: React.FC = () => {
  const s = "review";
  const from = SCENE_FROM(s);
  const map: Pair[] = [[from, 281], [W(s, "kai", 1, -4), 288], [W(s, "ira", 1, -4), 318], [W(s, "dev", 1, -4), 360], [W(s, "sign", 1, -4), 418], [W(s, "revision"), 430]];
  const cards: [string, string, string, string, number][] = [
    ["KAI", "TECH LEAD · CODE REVIEW", "“Prevents quantities dropping below zero, formats prices in INR.”", "kai", 0],
    ["IRA", "DESIGNER · 1280px + 390px", "“A cohesive milk, leaf and turmeric palette.”", "ira", 1],
    ["DEV", "QA · 6 WIDTHS + KEYBOARD", "“At 320 to 1280px the document had no horizontal overflow.”", "dev", 2],
  ];
  return (
    <AbsoluteFill>
      <Kicker text="STEP 5 · REVIEW, IN PARALLEL" x={90} at={from + 18} y={46} size={24} />
      <ScreenBox at={from + 4} x={90} y={130} w={1150} rotate={-0.6} enterFrom="left" cams={[{ f: from, cx: 1000, cy: 560, z: 1.12 }]}
        badge={(g) => <RunBadge g={g} clock={runClock(remap(g, map))} speed="TIME-LAPSE" size={13} />}>
        <Footage src="main" map={map} />
        <MarkerBox at={W(s, "kai", 1, 4)} box={[805, 640, 300, 250]} color={C.yellow} exit={W(s, "ira")} />
      </ScreenBox>
      {cards.map(([n, role, quote, w, i]) => (
        <React.Fragment key={n}>
          <Pop at={W(s, w)} x={1290} y={150 + i * 285} rotate={[-1.5, 1.5, -1][i]}>
            <TornPaper w={560} h={250} fill={C.card} seed={i * 9 + 4}>
              <div style={{ padding: "22px 28px" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
                  <div style={{ fontFamily: FONT.number, fontSize: 56, lineHeight: 1 }}>{n}</div>
                  <div style={{ fontFamily: FONT.typewriter, fontWeight: 700, fontSize: 17, letterSpacing: "0.1em", color: C.grey }}>{role}</div>
                </div>
                <div style={{ fontFamily: FONT.headline, fontStyle: "italic", fontSize: 29, lineHeight: 1.25, marginTop: 14, color: C.ink, width: 470 }}>{quote}</div>
              </div>
            </TornPaper>
          </Pop>
          <Stamp at={W(s, "sign", 1, i * 5)} x={1730} y={358 + i * 285} text="APPROVED" size={46} rotate={-12 + i * 4} />
        </React.Fragment>
      ))}
      <Tag at={W(s, "together")} x={260} y={960} text="CHANGES GO BACK IN ONE REVISION" color="yellow" size={36} rotate={-2} />
    </AbsoluteFill>
  );
};

/* ---------------------------------------------------------------- VERIFY */
export const Verify: React.FC = () => {
  const g = useCurrentFrame();
  const s = "verify";
  const from = SCENE_FROM(s);
  const reportAt = LS(s, 5, -6);
  const map = mapRel("chatview", [[from, 430], [W(s, "first", 1, -4), 446], [W(s, "marked"), 470], [W(s, "maya"), 540], [W(s, "start", 1, -4), 593], [W(s, "again"), 760], [reportAt, 962]]);
  const marks = ["✗", "✗", "✗", "✗", "✗", "✗", "✓"];
  const scrollY = kf(g, [reportAt + 10, LE(s, 5, 20)], [-380, -900], ease.inOut);
  return (
    <AbsoluteFill>
      <Kicker text="STEP 6 · VERIFY WITH EVIDENCE" x={90} at={from + 18} y={46} size={24} />
      <Life at={0} exit={reportAt + 4}>
        <Headline scene={s} text="A verifier runs / ==the real product.==" at={LS(s, 1)} y={90} x={90} align="left" size={58} width={700} />
        <ScreenBox at={from + 4} x={700} y={140} w={1150} rotate={0.5} enterFrom="right" cams={[{ f: from, cx: 1700, cy: 560, z: 1.55 }]}
          badge={(gg) => <RunBadge g={gg} clock={runClock(remap(gg, map) + OFF.chatview)} speed="TIME-LAPSE" size={13} />}>
          <Footage src={STREAM_FILE.chatview} map={map} />
        </ScreenBox>
        <Pop at={W(s, "marked", 1, -6)} x={90} y={330} rotate={-2}>
          <TornPaper w={520} h={530} fill={C.card} seed={61}>
            <div style={{ padding: "22px 30px" }}>
              <div style={{ fontFamily: FONT.typewriter, fontWeight: 700, fontSize: 19, letterSpacing: "0.14em", color: C.red }}>ACCEPTANCE CHECK #1 · DEV</div>
              {marks.map((m, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", marginTop: 12, fontFamily: FONT.number, fontSize: 34, opacity: prog(g, W(s, "marked", 1, i * 2), 3) }}>
                  <span>R{i + 1}</span><span style={{ color: m === "✓" ? C.green : C.red }}>{m === "✓" ? "MET" : "NOT MET"}</span>
                </div>
              ))}
            </div>
          </TornPaper>
        </Pop>
        <Tag at={W(s, "maya")} x={300} y={830} text="BACK TO MAYA" color="red" size={42} rotate={-4} />
        <Tag at={W(s, "start", 1, 2)} x={110} y={940} text="+ package.json  ->  npm start" color="yellow" size={32} rotate={2} font="typewriter" />
      </Life>
      <Life at={reportAt}>
        <Pop at={reportAt} x={330} y={90} rotate={-1}>
          <TornPaper w={1010} h={930} fill="#1C1B1A" seed={77} amp={5}>
            <div style={{ position: "absolute", left: 30, top: 24, right: 30, bottom: 24, overflow: "hidden" }}>
              <div style={{ position: "absolute", left: 0, top: scrollY }}>
                <Img src={staticFile("shots/report-card.png")} style={{ width: 941, display: "block" }} />
                <Highlight at={W(s, "seven", 1, 4)} box={[305, 490, 66, 900]} />
              </div>
            </div>
          </TornPaper>
        </Pop>
        <Label text="THE FINAL REPORT, AS OCTOPUS WROTE IT" at={reportAt + 6} x={1380} y={140} size={18} />
        <Sticker at={W(s, "seven")} x={1390} y={400} top="REQUIREMENTS MET" main="7 / 7" w={440} size={110} rotate={3} />
        <Tag at={W(s, "note")} x={1420} y={720} text="EACH WITH EVIDENCE" color="yellow" size={36} rotate={-3} />
      </Life>
    </AbsoluteFill>
  );
};
