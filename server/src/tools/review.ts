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
    "Ask read-only specialists to check your change, in fresh contexts: reviewer (correctness), security (input, secrets, files, access), " +
    "designer (how the UI looks; it runs the app in the browser) and verifier (checks each ask in the user's messages by running the product). " +
    "Reviewers run at the same time and the verifier runs after them, and you get their findings in one message. " +
    "They never change files. Name the change and what you already checked in focus.",
  args: z.object({
    specialists: z.array(z.enum(["reviewer", "security", "designer", "verifier"])).min(1).max(4).describe("Which specialists check the change"),
    focus: z.string().min(5).describe("What changed, where, and what you already ran or saw"),
  }),
  async run(ctx, a) {
    if (!ctx.specialists) return { text: "Review is not available in this conversation.", ok: false };
    const names = [...new Set(a.specialists)];
    return { text: await ctx.specialists.review(names, a.focus) };
  },
});

export const askVerdictTool = defineTool({
  name: "submit_acceptance",
  description: "Submit your acceptance check: one entry for each ask. Give an ask the id it was listed with when you check it again; leave the id out for an ask you add. met means you saw it work in the running product. For an ask you could not observe, say unmet and what would be needed to check it.",
  args: z.object({
    asks: z.array(z.object({
      id: z.string().optional().describe("The ask's id when it was listed to you, e.g. R2"),
      ask: z.string().min(3).describe("The ask, in the user's words"),
      met: z.boolean(),
      evidence: z.string().min(5).describe("What you did and saw"),
    })).min(1),
  }),
  async run(_ctx, a) {
    return { text: "Acceptance submitted.", stop: { kind: "asks", asks: a.asks.map((x) => ({ id: x.id?.trim().toUpperCase(), ask: x.ask, met: x.met, evidence: x.evidence })) } };
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
