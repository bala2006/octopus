/**
 * The main agent's calls to its read-only specialists. `review` runs reviewers in parallel and returns their findings as
 * one message. `explore` answers one question. Both leave the project as it was: the specialists cannot write, and the
 * engine restores any file a check changed.
 */
import { z } from "zod";
import { defineTool } from "./types";

export const reviewCallTool = defineTool({
  name: "review",
  description:
    "Ask read-only specialists to check your change, in fresh contexts: reviewer (correctness), security (input, secrets, files, access) " +
    "and designer (how the UI looks; it runs the app in the browser). They run at the same time, and you get their findings in one message. " +
    "They never change files. Name the change and what you already checked in focus.",
  args: z.object({
    specialists: z.array(z.enum(["reviewer", "security", "designer"])).min(1).max(3).describe("Which specialists review the change"),
    focus: z.string().min(5).describe("What changed, where, and what you already ran or saw"),
  }),
  async run(ctx, a) {
    if (!ctx.specialists) return { text: "Review is not available in this conversation.", ok: false };
    const names = [...new Set(a.specialists)];
    return { text: await ctx.specialists.review(names, a.focus) };
  },
});

export const exploreTool = defineTool({
  name: "explore",
  description:
    "Ask one question about the project or the web, and get a short answer with the file paths, lines or links it rests on. " +
    "Use it to find out something without reading many files yourself. Several explore calls in one step run at the same time.",
  args: z.object({ question: z.string().min(5).describe("One question, specific enough to answer in one search") }),
  readOnly: true,
  async run(ctx, a) {
    if (!ctx.specialists) return { text: "Explore is not available in this conversation.", ok: false };
    return { text: await ctx.specialists.explore(a.question) };
  },
});
