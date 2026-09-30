/**
 * Resilient WebSocket: exponential backoff reconnect, heartbeat awareness, outbound queue while
 * disconnected, and (for run streams) event replay from the last seen `seq`.
 */
export type SocketState = "connecting" | "open" | "reconnecting" | "closed";

export interface SocketOptions<E> {
  url: (lastSeq: number) => string;
  onEvent: (e: E) => void;
  onState?: (s: SocketState, attempt: number) => void;
  seqOf?: (e: E) => number | undefined;
  maxBackoffMs?: number;
}

export class ResilientSocket<E = unknown> {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private closedByUser = false;
  private lastSeq = 0;
  private queue: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: SocketOptions<E>) {
    this.connect();
  }

  get seq(): number {
    return this.lastSeq;
  }

  private connect(): void {
    this.opts.onState?.(this.attempt === 0 ? "connecting" : "reconnecting", this.attempt);
    const ws = new WebSocket(this.opts.url(this.lastSeq));
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.opts.onState?.("open", 0);
      for (const m of this.queue.splice(0)) ws.send(m);
    };
    ws.onmessage = (msg) => {
      let e: E;
      try { e = JSON.parse(msg.data as string) as E; } catch { return; }
      const t = (e as { type?: string }).type;
      if (t === "ping") { this.send({ type: "pong" }); return; }
      const s = this.opts.seqOf?.(e);
      if (s !== undefined) {
        if (s <= this.lastSeq) return; // de-dupe replays
        this.lastSeq = s;
      }
      this.opts.onEvent(e);
    };
    ws.onclose = (ev) => {
      this.ws = null;
      if (this.closedByUser || ev.code === 4401 || ev.code === 4404) {
        this.opts.onState?.("closed", this.attempt);
        return;
      }
      this.attempt += 1;
      const delay = Math.min(this.opts.maxBackoffMs ?? 8000, 300 * 2 ** (this.attempt - 1)) + Math.random() * 200;
      this.opts.onState?.("reconnecting", this.attempt);
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }

  send(data: unknown): void {
    const m = JSON.stringify(data);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(m);
    else this.queue.push(m);
  }

  close(): void {
    this.closedByUser = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
  }
}
