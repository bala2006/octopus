import * as React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEvent } from "@/types";
import { useRunStream } from "./useRunStream";

const mock = vi.hoisted(() => ({
  sockets: [] as Array<{
    onEvent: (e: RunEvent) => void;
    close: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock("@/lib/socket", () => ({
  ResilientSocket: class {
    close = vi.fn();
    send = vi.fn();
    constructor(options: { onEvent: (e: RunEvent) => void }) {
      mock.sockets.push({ onEvent: options.onEvent, close: this.close });
    }
  },
}));

describe("switching workbench conversations", () => {
  beforeEach(() => {
    mock.sockets.length = 0;
  });
  it("clears the old feed, artifacts and replay sequence and ignores late events from a closed socket", async () => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(
      ({ id }) => useRunStream("workspace", id, {}),
      { wrapper, initialProps: { id: "one" as string | undefined } },
    );
    act(() => {
      mock.sockets[0].onEvent({
        type: "message_created",
        seq: 9,
        data: {
          message: {
            id: "old",
            content: "Old conversation",
            sender: "user",
            type: "user_interjection",
            from_agent_id: null,
            to_agent_id: null,
          },
        },
      });
      mock.sockets[0].onEvent({
        type: "artifact_updated",
        seq: 10,
        data: { artifact: { path: "old.ts", id: "file", version: 1 } },
      });
    });
    await waitFor(() => expect(result.current.state.messages).toHaveLength(1));
    rerender({ id: "two" });
    expect(mock.sockets[0].close).toHaveBeenCalledOnce();
    await waitFor(() => expect(result.current.state.lastSeq).toBe(0));
    expect(result.current.state.messages).toEqual([]);
    expect(result.current.state.artifacts).toEqual({});
    expect(result.current.eventCount).toBe(0);
    act(() => {
      mock.sockets[0].onEvent({
        type: "artifact_updated",
        seq: 11,
        data: { artifact: { path: "late.ts", id: "late", version: 1 } },
      });
      mock.sockets[1].onEvent({
        type: "run_status",
        seq: 1,
        data: { status: "paused" },
      });
    });
    await waitFor(() => expect(result.current.state.status).toBe("paused"));
    expect(result.current.state.artifacts).toEqual({});
    rerender({ id: undefined });
    await waitFor(() => expect(result.current.state.status).toBe("queued"));
    expect(mock.sockets[1].close).toHaveBeenCalledOnce();
  });
});
