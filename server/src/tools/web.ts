/** Web research: search (DuckDuckGo's HTML endpoint, no key needed) and reading a page as text. */
import { z } from "zod";
import { clip } from "../lib/util";
import { defineTool } from "./types";

const UA = "Mozilla/5.0 (compatible; Octopus/2.0; +https://github.com/bala2006/octopus)";

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}

function allowedUrl(raw: string): URL {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http and https URLs can be fetched");
  if (/^(169\.254\.|metadata\.|100\.100\.100\.200$|\[fd00:ec2)/i.test(url.hostname)) throw new Error("Cloud metadata addresses are blocked");
  return url;
}

export const webTools = [
  defineTool({
    name: "web_search",
    description: "Search the web. Returns titles, URLs and snippets; use fetch_url to read a result.",
    args: z.object({ query: z.string().min(2) }),
    async run(ctx, a) {
      ctx.setStatus("tool", `Searching the web for “${a.query}”`);
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(a.query)}`, { headers: { "user-agent": UA }, signal: ctx.signal });
      const html = await res.text();
      const results = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].slice(0, 8).map((m) => {
        const href = m[1]!.includes("uddg=") ? decodeURIComponent(m[1]!.split("uddg=")[1]!.split("&")[0]!) : m[1]!;
        return `- ${htmlToText(m[2]!)}\n  ${href}\n  ${htmlToText(m[3]!)}`;
      });
      return { text: results.length ? results.join("\n") : "No results (the search service may be unavailable).", ok: results.length > 0 };
    },
  }),
  defineTool({
    name: "fetch_url",
    description: "Read a web page or text resource as plain text (docs, articles, API references).",
    args: z.object({ url: z.string().url() }),
    async run(ctx, a) {
      const url = allowedUrl(a.url);
      ctx.setStatus("tool", `Reading ${url.hostname}`);
      const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)]), redirect: "follow" });
      const type = res.headers.get("content-type") ?? "";
      if (!/text|json|xml|javascript/.test(type)) return { text: `${url} returned ${type || "binary content"}, which cannot be read as text.`, ok: false };
      const body = await res.text();
      return { text: `${res.status} ${url}\n${clip(type.includes("html") ? htmlToText(body) : body, 24_000)}`, ok: res.ok };
    },
  }),
];
