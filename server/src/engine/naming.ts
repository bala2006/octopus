/**
 * A conversation's name. The model writes a short title from the conversation's first request. Until it lands, the name
 * is the goal's first line.
 */
import { config } from "../config";
import type { Registry } from "../db/registry";
import { complete } from "../llm/azure";

export async function conversationName(reg: Registry, goal: string): Promise<string> {
  const res = await complete(reg, {
    model: config.defaultModel,
    instructions: "Name this conversation. Reply with a short title of three to six plain words that says what the user wants. No quotes, no trailing punctuation, and nothing else.",
    input: [{ role: "user", content: goal.slice(0, 2000) }],
    effort: "low",
    maxOutputTokens: 60,
  });
  const line = res.text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.replace(/^["'`*#\s]+|["'`*\s.!?]+$/g, "").slice(0, 80);
}