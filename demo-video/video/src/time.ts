// Narration timing: every visual cue is anchored to a spoken word on the Sarvam voice track.
import timing from "../public/audio/timing.json";

export const FPS = 30;
export const sec = (s: number) => Math.round(s * FPS);

type Word = { w: string; t: number };
type Line = { text: string; start: number; end: number; words: Word[] };
type Scene = { id: string; start: number; end: number; lines: Line[] };
export const T = timing as unknown as { duration: number; scenes: Scene[] };

export const DURATION = Math.ceil(T.duration * FPS) + sec(3);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function sceneOf(id: string): Scene {
  const s = T.scenes.find((x) => x.id === id);
  if (!s) throw new Error(`No scene ${id}`);
  return s;
}

/** Global frame of the nth spoken occurrence of `word` in a scene (prefix match for 4+ letters). */
export function W(id: string, word: string, nth = 1, offsetFrames = 0): number {
  const want = norm(word);
  let n = 0;
  for (const line of sceneOf(id).lines) {
    for (const w of line.words) {
      const got = norm(w.w);
      if (got === want || (want.length >= 4 && got.startsWith(want))) {
        n++;
        if (n === nth) return sec(w.t) + offsetFrames;
      }
    }
  }
  throw new Error(`Word "${word}" #${nth} not found in scene ${id}`);
}

/** Global frame where line i of a scene starts / ends. */
export const LS = (id: string, i: number, off = 0) => sec(sceneOf(id).lines[i].start) + off;
export const LE = (id: string, i: number, off = 0) => sec(sceneOf(id).lines[i].end) + off;

/** Visual windows: each page arrives a little before its narration and overlaps the next push. */
export const PUSH = 14;
export function windows() {
  const out: { id: string; from: number; to: number; index: number }[] = [];
  T.scenes.forEach((s, i) => {
    const from = i === 0 ? 0 : sec(s.start) - 16;
    const next = T.scenes[i + 1];
    const to = next ? sec(next.start) - 16 + PUSH + 2 : DURATION;
    out.push({ id: s.id, from, to, index: i });
  });
  return out;
}
export const SCENE_FROM = (id: string) => windows().find((w) => w.id === id)!.from;
export const SCENE_TO = (id: string) => windows().find((w) => w.id === id)!.to;
