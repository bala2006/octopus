/**
 * A stand-in for Azure OpenAI's Responses API: an HTTP server that streams scripted replies over SSE, so tests run
 * the real client, agent loop and engine without a network or a model.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tokensOf } from "../src/engine/agent";

export type Reply = { text?: string; calls?: { name: string; args: Record<string, unknown> }[]; /** Input tokens the response reports; by default the size of the request. */ usage?: number; /** Cached input tokens the response reports; 10 by default. */ cached?: number };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Script = (body: any) => Reply;

export interface FakeModel { url: string; requests: any[]; close(): Promise<void> } // eslint-disable-line @typescript-eslint/no-explicit-any

let counter = 0;

export async function fakeModel(script: Script, listenPort = 0): Promise<FakeModel> {
  const requests: unknown[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      // The conversation's name is a side request the engine makes on its own. It gets a fixed answer, and the scripts and
      // request logs cover the agent's requests only.
      const naming = String(body.instructions ?? "").startsWith("Name this conversation.");
      if (!naming) requests.push(body);
      const reply = naming ? { text: "Test conversation" } : script(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      const output: unknown[] = [];
      if (reply.text) {
        for (const chunk of reply.text.match(/.{1,20}/gs) ?? []) send({ type: "response.output_text.delta", delta: chunk });
        output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: reply.text }] });
      }
      for (const c of reply.calls ?? []) {
        const id = `fc_${++counter}`;
        const call_id = `call_${counter}`;
        const args = JSON.stringify(c.args);
        send({ type: "response.output_item.added", item: { type: "function_call", id, call_id, name: c.name } });
        send({ type: "response.function_call_arguments.delta", item_id: id, delta: args });
        output.push({ type: "function_call", id, call_id, name: c.name, arguments: args });
      }
      send({ type: "response.completed", response: { status: "completed", output, usage: { input_tokens: reply.usage ?? tokensOf(body.input), output_tokens: 50, input_tokens_details: { cached_tokens: reply.cached ?? 10 }, output_tokens_details: { reasoning_tokens: 5 } } } });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(listenPort, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests: requests as never[], close: () => new Promise((r) => server.close(() => r())) };
}

/** Which kind of turn a request is, from the agent's instructions. */
export function turnKind(body: { instructions: string }): "solo" | "plan" | "work" | "review" | "acceptance" | "report" | "consult" | "chat" {
  const s = body.instructions;
  if (s.includes("You are Octopus, a coding agent")) return "solo";
  if (s.includes("## Direct chat")) return "chat";
  if (s.includes("A teammate's question")) return "consult";
  if (s.includes("You are reviewing a teammate's work")) return "review";
  if (s.includes("## Acceptance check")) return "acceptance";
  if (s.includes("You own this part")) return "work";
  return body.instructions.includes("## How you work") && (body as { tools?: unknown[] }).tools?.length ? "plan" : "report";
}

/** Function outputs in the current turn (since the last user message): how many tool rounds this turn has had. */
export const outputs = (body: { input: { type?: string; role?: string; output?: string }[] }) => {
  const start = body.input.findLastIndex((i) => i.role === "user");
  return body.input.slice(start + 1).filter((i) => i.type === "function_call_output");
};
