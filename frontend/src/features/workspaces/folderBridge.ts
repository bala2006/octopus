/**
 * The laptop-side folder picker (scripts/folder_bridge.py). When the backend runs in Docker it can't show the OS folder
 * dialog, but the browser runs on the laptop: it asks the helper on 127.0.0.1 to show the dialog and gets the chosen
 * laptop path back, which the backend maps onto the folder shared with the container.
 */
type FetchFn = typeof fetch;

export async function bridgeAvailable(url: string, f: FetchFn = fetch, timeoutMs = 1500): Promise<boolean> {
  if (!url) return false;
  try {
    const res = await f(`${url.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    return !!(await res.json()).ok;
  } catch {
    return false; // not running (or blocked): fall back to the in-app browser
  }
}

/** Show the laptop's folder dialog. Resolves to the chosen laptop path, or null if the user cancelled. */
export async function bridgePick(url: string, f: FetchFn = fetch): Promise<string | null> {
  const res = await f(`${url.replace(/\/$/, "")}/pick`, { method: "POST" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Folder picker failed (${res.status})`);
  return body.cancelled || !body.path ? null : String(body.path);
}
