/**
 * Soft palette helpers. Agent and department colours are stored as hex in company data (often vivid Tailwind tones);
 * `tone()` keeps their hue but brings saturation and lightness into the calm range of the design system, so old and new
 * companies look consistent and easy on the eyes in both themes.
 */
const cache = new Map<string, string>();

export function tone(hex: string | null | undefined): string {
  if (!hex) return "#8A8780";
  const key = hex.toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const [h, s, l] = rgbToHsl((n >> 16) & 255, (n >> 8) & 255, n & 255);
  const out = hslToHex(h, Math.min(s, 0.4), Math.min(Math.max(l, 0.46), 0.6));
  cache.set(key, out);
  return out;
}

/** Brand-aligned choices for the colour pickers (agents, departments). */
export const SOFT_COLORS = ["#D97756", "#66839A", "#6B8440", "#C9A04A", "#8E7AA8", "#5E9C94", "#C0655A", "#8A7F6E", "#B58D5E", "#7B8FB8", "#A36F8C", "#7E9B6A"];

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const f = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r = l, g = l, b = l;
  if (s) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3);
  }
  return `#${[r, g, b].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("")}`;
}
