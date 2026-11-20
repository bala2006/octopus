import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, FONT } from "../theme";
import { ease, kf, prog } from "../lib";
import { LE, LS, SCENE_FROM, W } from "../time";
import { BigText, Headline, Kicker, Label, Life, MaskRise, Pop, SourceLine, TornPaper } from "../components/base";
import { Arrow, Badge, MarkerCircle, Stamp, Sticker, Strike, Tag } from "../components/marks";
import { ChaiGlass, FolderArt, Icon, Logo, RoleCard } from "../components/icons";

/* ------------------------------------------------------------------ HOOK */
export const Hook: React.FC = () => {
  const g = useCurrentFrame();
  const s = "hook";
  const out1 = LS(s, 3, -6);
  const roles: [string, React.ComponentProps<typeof Icon>["name"], string, number, number, number][] = [
    ["DEVELOPER", "code", "developer", 170, 640, -5],
    ["DESIGNER", "palette", "designer", 560, 720, 3],
    ["REVIEWER", "search", "reviewer", 1060, 720, -2],
    ["TESTER", "check", "tester", 1450, 640, 4],
  ];
  return (
    <AbsoluteFill>
      <Kicker text="OCTOPUS · A REAL RUN, RECORDED START TO FINISH" at={4} />
      <Life at={0} exit={out1}>
        <Headline scene={s} text="Open a folder. / Type ==one message.==" at={W(s, "open")} y={110} size={84} />
        <Pop at={W(s, "folder")} x={790} y={360} rotate={-3}><FolderArt w={340} /></Pop>
        <Pop at={W(s, "message")} x={1130} y={330} rotate={2}>
          <TornPaper w={430} h={130} fill="#FFFFFF" seed={8}>
            <div style={{ padding: "18px 24px", fontFamily: FONT.ui, fontSize: 25, color: C.ink, lineHeight: 1.35 }}>“Build a landing page for my chai cafe in Bengaluru…”</div>
          </TornPaper>
        </Pop>
        <Arrow at={W(s, "message", 1, 6)} from={[1215, 475]} to={[1050, 505]} bend={0.35} />
        <Tag at={W(s, "chatbot")} x={250} y={420} text="ONE CHATBOT" color="white" size={44} rotate={-6} />
        <div style={{ position: "absolute", inset: 0, zIndex: 20, transform: "rotate(-6deg)", transformOrigin: "372px 452px" }}><Strike at={W(s, "chatbot", 1, 8)} x1={228} x2={518} y={456} /></div>
        <Tag at={W(s, "team", 2)} x={1380} y={520} text="A TEAM." color="yellow" size={58} rotate={4} />
        {roles.map(([t, ic, word, x, y, r], i) => (
          <Pop key={t} at={W(s, word)} x={x} y={y} rotate={r}><RoleCard icon={ic} title={t} w={300} h={210} seed={i * 5 + 2} /></Pop>
        ))}
      </Life>
      <Life at={W(s, "octopus", 1, -3)} exit={LS(s, 4, -2)} style={{}}>
        <div style={{ position: "absolute", left: 0, top: 210, width: "100%", display: "flex", justifyContent: "center", transform: `scale(${kf(g - W(s, "octopus"), [0, 4, 7, 10], [0.6, 1.08, 0.97, 1])})` }}><Logo size={360} /></div>
        <BigText text="OCTOPUS" at={W(s, "octopus", 1, 2)} y={600} size={210} />
      </Life>
      <Life at={LS(s, 4, -2)}>
        <div style={{ position: "absolute", left: 720, top: 150, opacity: prog(g, LS(s, 4), 6) }}><Logo size={140} /></div>
        <MaskRise text="OCTOPUS" at={LS(s, 4)} size={150} style={{ position: "absolute", left: 880, top: 140 }} />
        <Headline scene={s} text="A ==real run,== start to finish." at={W(s, "real")} y={400} size={86} />
        <Label text="gpt-6-luna on Azure OpenAI  ·  15 minutes  ·  5 agents  ·  one chai cafe website" at={W(s, "finish")} x={960} y={540} align="center" size={24} />
        <Stamp at={W(s, "staged")} x={960} y={740} text="NOTHING STAGED" size={96} rotate={-6} />
      </Life>
    </AbsoluteFill>
  );
};

/* --------------------------------------------------------------- PROBLEM */
export const Problem: React.FC = () => {
  const s = "problem";
  const out = LS(s, 2, -6);
  const steps: [string, string, number, boolean][] = [["YOU ASK", "ask", 380, false], ["IT WRITES", "writes", 820, false], ["YOU CHECK EVERYTHING", "check", 1260, true]];
  const lanes: [string, React.ComponentProps<typeof Icon>["name"], string, string][] = [
    ["BUILDS", "code", "builds", "1"], ["REVIEWS THE CODE", "search", "reviews", "2"], ["CHECKS THE DESIGN", "palette", "design", "3"], ["CLICKS THROUGH IT", "cursor", "clicks", "4"],
  ];
  return (
    <AbsoluteFill>
      <Kicker text="HOW MOST AI CODING TOOLS WORK" at={SCENE_FROM(s) + 18} />
      <Life at={0} exit={out}>
        <Headline scene={s} text="One very ==fast intern.==" at={LS(s, 0)} y={120} size={84} />
        <Pop at={W(s, "intern")} x={110} y={470} rotate={-3}>
          <TornPaper w={230} h={260} fill={C.card} seed={9}>
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <Icon name="person" size={110} />
              <div style={{ fontFamily: FONT.number, fontSize: 34 }}>1 AGENT</div>
            </div>
          </TornPaper>
        </Pop>
        {steps.map(([t, w, x, red], i) => (
          <React.Fragment key={t}>
            <Pop at={W(s, w)} x={x} y={530} rotate={i % 2 ? 2 : -2}>
              <TornPaper w={red ? 520 : 330} h={130} fill={red ? C.red : "#FFFFFF"} seed={i + 3}>
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.number, fontSize: red ? 54 : 50, color: red ? "#fff" : C.ink }}>{t}</div>
              </TornPaper>
            </Pop>
            {i > 0 && <Arrow at={W(s, w, 1, -4)} from={[x - 110, 600]} to={[x - 20, 600]} bend={-0.25} color={C.ink} width={5} />}
          </React.Fragment>
        ))}
        <Label text="…every file, every edge case, every time." at={W(s, "yourself")} x={1260} y={690} size={30} font="headline" color={C.grey} />
      </Life>
      <Life at={LS(s, 2, -2)} exit={LS(s, 3, -6)}>
        <Headline scene={s} text="But real software is / **not built like that.**" at={LS(s, 2)} y={330} size={104} />
      </Life>
      <Life at={LS(s, 3, -2)}>
        <Headline scene={s} text="Real teams ==split the work.==" at={LS(s, 3)} y={110} size={84} />
        {lanes.map(([t, ic, w, n], i) => (
          <Pop key={t} at={W(s, w)} x={150 + i * 420} y={380 + (i % 2) * 40} rotate={[-3, 2, -1.5, 3][i]}>
            <RoleCard icon={ic} title={t} w={380} h={300} seed={i * 3 + 1} num={n} accent={i === 3 ? C.red : C.ink} />
          </Pop>
        ))}
        <Tag at={W(s, "ships")} x={1340} y={800} text="BEFORE IT SHIPS" color="yellow" size={44} rotate={-3} />
      </Life>
    </AbsoluteFill>
  );
};

/* ------------------------------------------------------------------ IDEA */
const Node: React.FC<{ title: string; sub: string; color?: string; w?: number; icon?: React.ComponentProps<typeof Icon>["name"]; logo?: boolean }> = ({ title, sub, color = C.card, w = 330, icon, logo }) => (
  <TornPaper w={w} h={120} fill={color} seed={w}>
    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", gap: 16, padding: "0 20px" }}>
      {logo ? <Logo size={78} /> : icon ? <Icon name={icon} size={58} /> : null}
      <div>
        <div style={{ fontFamily: FONT.number, fontSize: 40, lineHeight: 1 }}>{title}</div>
        <div style={{ fontFamily: FONT.typewriter, fontWeight: 700, fontSize: 15, letterSpacing: "0.12em", color: C.grey, marginTop: 6 }}>{sub}</div>
      </div>
    </div>
  </TornPaper>
);

export const Idea: React.FC = () => {
  const g = useCurrentFrame();
  const s = "idea";
  const out = LS(s, 3, -6);
  const hires: [string, string, React.ComponentProps<typeof Icon>["name"], number][] = [["DEVELOPER", "BUILDS IT", "code", 300], ["DESIGNER", "JUDGES THE LOOK", "palette", 790], ["QA", "BREAKS IT FIRST", "check", 1280]];
  const cycle: [string, string][] = [["PLAN", "plan"], ["BUILD", "build"], ["REVIEW", "review"], ["VERIFY", "verify"], ["REPORT", "report"]];
  const hireAt = W(s, "hires");
  return (
    <AbsoluteFill>
      <Kicker text="THE IDEA" at={SCENE_FROM(s) + 18} />
      <Life at={0} exit={out}>
        <Headline scene={s} text="Octopus copies ==that structure.==" at={LS(s, 0)} y={100} size={76} />
        <Pop at={W(s, "lead")} x={790} y={250} rotate={-1}><Node title="OCTOPUS" sub="THE TEAM LEAD YOU TALK TO" logo w={420} /></Pop>
        <Pop at={W(s, "you")} x={260} y={265} rotate={-4}><Node title="YOU" sub="ONE CONVERSATION" icon="chat" w={260} /></Pop>
        <Arrow at={W(s, "lead", 1, 4)} from={[540, 330]} to={[770, 320]} bend={-0.15} color={C.ink} width={5} />
        {["R1", "R2", "R3", "R4"].map((r, i) => (
          <Tag key={r} at={W(s, "numbered", 1, i * 3)} x={1260 + i * 92} y={280 + (i % 2) * 18} text={r} color={i === 0 ? "red" : "white"} size={40} rotate={[-6, 4, -3, 5][i]} />
        ))}
        <Label text="YOUR ASKS, NUMBERED, IN YOUR WORDS" at={W(s, "requirements")} x={1260} y={370} size={17} />
        {hires.map(([t, sub, ic, x], i) => (
          <React.Fragment key={t}>
            <Arrow at={hireAt + i * 4} from={[1000, 380]} to={[x + 170, 610]} bend={0.08 * (i - 1)} color={C.inkSoft} width={4} frames={8} />
            <Pop at={W(s, "specialists", 1, i * 4)} x={x} y={620} rotate={[-2, 1.5, -1][i]}><Node title={t} sub={sub} icon={ic} w={360} /></Pop>
          </React.Fragment>
        ))}
        <Tag at={W(s, "needs")} x={760} y={810} text="HIRED FOR THIS JOB" color="yellow" size={40} rotate={-2} />
      </Life>
      <Life at={LS(s, 3, -2)}>
        <Headline scene={s} text="Then ==the cycle runs.==" at={LS(s, 3)} y={130} size={84} />
        {cycle.map(([t, w], i) => {
          const at = W(s, w);
          return (
            <React.Fragment key={t}>
              <Pop at={at} x={140 + i * 342} y={430} rotate={[-2, 1, -1, 2, -1][i]}>
                <TornPaper w={290} h={150} fill={i === 3 ? C.red : C.card} seed={i * 7 + 2}>
                  <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 14, fontFamily: FONT.number, fontSize: 60, color: i === 3 ? "#fff" : C.ink }}>
                    <span style={{ fontFamily: FONT.typewriter, fontSize: 22, opacity: 0.6 }}>{i + 1}</span>{t}
                  </div>
                </TornPaper>
              </Pop>
              {i > 0 && <Arrow at={at - 3} from={[140 + i * 342 - 48, 505]} to={[140 + i * 342 - 6, 505]} bend={0} color={C.ink} width={5} frames={5} />}
            </React.Fragment>
          );
        })}
        <Arrow at={W(s, "report", 1, 10)} from={[1290, 610]} to={[700, 610]} bend={-0.22} color={C.red} width={6} frames={12} />
        <Label text="FAILS GO BACK TO THE OWNER" at={W(s, "report", 1, 18)} x={995} y={770} align="center" size={20} color={C.red} />
        <Tag at={W(s, "owner")} x={160} y={840} text="ONE OWNER PER PART" color="white" size={44} rotate={-3} />
        <Stamp at={W(s, "checked")} x={1380} y={880} text="NOT DONE UNTIL CHECKED" size={60} rotate={-5} />
      </Life>
    </AbsoluteFill>
  );
};

/* --------------------------------------------------------------- NUMBERS */
const Counter: React.FC<{ at: number; to: number; dur: number; decimals?: number; prefix?: string; size: number; color?: string }> = ({ at, to, dur, decimals = 0, prefix = "", size, color = C.ink }) => {
  const g = useCurrentFrame();
  if (g < at) return null;
  const v = to * prog(g, at, dur, ease.out);
  return <div style={{ fontFamily: FONT.number, fontSize: size, lineHeight: 1, color, opacity: prog(g, at, 3) }}>{prefix}{v.toFixed(decimals)}</div>;
};

export const Numbers: React.FC = () => {
  const g = useCurrentFrame();
  const s = "numbers";
  const dimAt = LS(s, 2, -4);
  const cards: [string, string, number, number][] = [["5", "AGENTS", W(s, "five"), 5], ["113", "MODEL CALLS", W(s, "hundred"), 113], ["2.4M", "TOKENS", W(s, "point"), 2.4]];
  return (
    <AbsoluteFill>
      <Kicker text="THE RECEIPT FOR THIS RUN" at={SCENE_FROM(s) + 18} />
      <Life at={0} dim={dimAt}>
        <div style={{ position: "absolute", left: 0, top: 120, width: "100%", display: "flex", justifyContent: "center", alignItems: "baseline", gap: 30 }}>
          <Counter at={W(s, "fifteen")} to={15} dur={14} size={250} />
          <MaskRise text="MINUTES" at={W(s, "minutes")} size={120} color={C.grey} />
        </div>
        {cards.map(([v, l, at, n], i) => (
          <Pop key={l} at={at} x={190 + i * 540} y={470} rotate={[-2, 1.5, -1][i]}>
            <TornPaper w={460} h={230} fill={C.card} seed={i * 4 + 9}>
              <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                <Counter at={at} to={n} dur={12} decimals={v.includes(".") ? 1 : 0} size={130} />
                <div style={{ fontFamily: FONT.typewriter, fontWeight: 700, fontSize: 24, letterSpacing: "0.14em", color: C.grey, marginTop: 8 }}>{l}{v.endsWith("M") ? " (MILLION)" : ""}</div>
              </div>
            </TornPaper>
          </Pop>
        ))}
      </Life>
      <Life at={W(s, "rupees", 1, -10)}>
        <div style={{ position: "absolute", left: 0, top: 230, width: "100%", display: "flex", justifyContent: "center", transform: `rotate(-2deg) scale(${kf(g - W(s, "rupees", 1, -10), [0, 5, 8, 11], [0.6, 1.07, 0.98, 1])})` }}>
          <TornPaper w={1060} h={420} fill={C.red} seed={31} amp={7}>
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#fff" }}>
              <div style={{ fontFamily: FONT.typewriter, fontWeight: 700, fontSize: 28, letterSpacing: "0.18em" }}>TOTAL COST OF THE RUN</div>
              <Counter at={W(s, "rupees", 1, -6)} to={5.49} dur={20} decimals={2} prefix="₹" size={290} color="#fff" />
            </div>
          </TornPaper>
        </div>
      </Life>
      <Life at={LS(s, 3, -2)}>
        <Pop at={LS(s, 3)} x={1500} y={600} rotate={6}><ChaiGlass w={190} /></Pop>
        <Tag at={W(s, "cutting")} x={1300} y={880} text="ONE CUTTING CHAI · ₹15" color="yellow" size={40} rotate={-4} />
        <Label text="price from the menu the team just built" at={W(s, "chai", 1, 8)} x={1310} y={950} size={18} />
      </Life>
      <SourceLine text="Source: Octopus Usage tab for this run · Azure-reported usage · 2,350,708 tokens · 13 min 23 s of model time" at={W(s, "fifteen")} />
    </AbsoluteFill>
  );
};

/* ----------------------------------------------------------------- CLOSE */
export const Close: React.FC = () => {
  const g = useCurrentFrame();
  const s = "close";
  return (
    <AbsoluteFill>
      <Life at={0} exit={LS(s, 2, -6)}>
        <Headline scene={s} text="You ask." at={LS(s, 0)} y={150} x={150} align="left" size={110} dark />
        <Headline scene={s} text="The team **plans, builds, reviews** / and **verifies.**" at={W(s, "team")} y={300} x={150} align="left" size={72} dark />
        <Headline scene={s} text="You get an ==honest report.==" at={LS(s, 1)} y={520} x={150} align="left" size={72} dark />
        <Label text="…and the same team is ready for your next message." at={W(s, "same")} x={152} y={640} size={34} font="headline" color={C.onBlackDim} />
      </Life>
      <Life at={LS(s, 2, -4)}>
        <div style={{ position: "absolute", left: 1220, top: 140, transform: `scale(${kf(g - LS(s, 2, -4), [0, 5, 8, 11], [0.5, 1.08, 0.97, 1])})`, filter: "invert(0)" }}>
          <div style={{ width: 420, height: 420, borderRadius: 420, background: C.paper, display: "flex", alignItems: "center", justifyContent: "center" }}><Logo size={330} /></div>
        </div>
        <MaskRise text="OCTOPUS" at={W(s, "octopus")} size={200} color={C.onBlack} style={{ position: "absolute", left: 150, top: 760 }} />
        <Label text="Your AI company, in one folder." at={W(s, "company")} x={156} y={980} size={44} font="headline" color={C.onBlack} />
        <Label text="github.com/bala2006/octopus" at={W(s, "company", 1, 6)} x={1770} y={1000} align="right" size={24} color={C.yellow} />
      </Life>
    </AbsoluteFill>
  );
};
