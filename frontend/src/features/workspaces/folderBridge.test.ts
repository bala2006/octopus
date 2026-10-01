import { describe, expect, it, vi } from "vitest";
import { bridgeAvailable, bridgePick } from "./folderBridge";

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

describe("laptop folder picker bridge", () => {
  it("is used only when the helper answers and has a dialog", async () => {
    expect(await bridgeAvailable("http://127.0.0.1:8765", vi.fn(() => json({ ok: true })) as unknown as typeof fetch)).toBe(true);
    expect(await bridgeAvailable("http://127.0.0.1:8765", vi.fn(() => json({ ok: false, reason: "no desktop" })) as unknown as typeof fetch)).toBe(false);
    expect(await bridgeAvailable("http://127.0.0.1:8765", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch)).toBe(false);
    expect(await bridgeAvailable("", vi.fn() as unknown as typeof fetch)).toBe(false);
  });

  it("returns the laptop path the user picked, or null on cancel", async () => {
    const f = vi.fn(() => json({ cancelled: false, path: "C:\\Users\\me\\code\\game" }));
    expect(await bridgePick("http://127.0.0.1:8765/", f as unknown as typeof fetch)).toBe("C:\\Users\\me\\code\\game");
    expect(f).toHaveBeenCalledWith("http://127.0.0.1:8765/pick", { method: "POST" });
    expect(await bridgePick("http://x", vi.fn(() => json({ cancelled: true, path: "" })) as unknown as typeof fetch)).toBeNull();
    await expect(bridgePick("http://x", vi.fn(() => json({ error: "A folder dialog is already open" }, 409)) as unknown as typeof fetch)).rejects.toThrow("already open");
  });
});
