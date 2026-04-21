// WebSocket fanout relay for horizontally-scaled API instances.
//
// Only the worker role owns the Firehose matchmaker. API instances keep
// one upstream WebSocket to that worker and rebroadcast public stream
// events to their local browser clients. This avoids multiple Cloud Run
// instances scheduling independent ranked matches.

import { WebSocket } from "ws";
import type { Client, ServerEvent } from "./firehose.js";

export class FanoutRelay {
  private clients = new Set<Client>();
  private nextClientId = 1;
  private upstream: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private running = false;
  private latestState: ServerEvent | null = null;

  constructor(private readonly upstreamOrigin: string) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.upstream) {
      try { this.upstream.close(); } catch { /* ignore */ }
      this.upstream = null;
    }
  }

  addClient(ws: WebSocket): Client {
    const c: Client = { ws, id: this.nextClientId++ };
    this.clients.add(c);
    if (this.latestState) this.sendTo(c, this.latestState);
    if (!this.upstream || this.upstream.readyState === WebSocket.CLOSED) this.connect();
    return c;
  }

  removeClient(c: Client): void {
    this.clients.delete(c);
  }

  private connect(): void {
    if (!this.running) return;
    if (this.upstream && (
      this.upstream.readyState === WebSocket.OPEN ||
      this.upstream.readyState === WebSocket.CONNECTING
    )) return;

    const url = `${this.upstreamOrigin.replace(/\/$/, "")}/ws`;
    const upstream = new WebSocket(url);
    this.upstream = upstream;

    upstream.on("open", () => {
      console.log(`[fanout] upstream connected ${url}`);
    });
    upstream.on("message", (raw) => {
      let ev: ServerEvent;
      try { ev = JSON.parse(raw.toString()) as ServerEvent; }
      catch { return; }
      this.rememberState(ev);
      this.broadcast(ev);
    });
    upstream.on("close", () => {
      if (this.upstream === upstream) this.upstream = null;
      this.scheduleReconnect();
    });
    upstream.on("error", (e) => {
      console.warn("[fanout] upstream error:", e instanceof Error ? e.message : e);
    });
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2000);
  }

  private rememberState(ev: ServerEvent): void {
    if (
      ev.type === "matchStart" ||
      ev.type === "matchInProgress" ||
      ev.type === "waiting" ||
      ev.type === "matchEnd"
    ) {
      this.latestState = ev;
    }
  }

  private sendTo(c: Client, ev: ServerEvent): void {
    if (c.ws.readyState !== WebSocket.OPEN) {
      this.clients.delete(c);
      return;
    }
    try { c.ws.send(JSON.stringify(ev)); }
    catch { this.clients.delete(c); }
  }

  private broadcast(ev: ServerEvent): void {
    const data = JSON.stringify(ev);
    for (const c of this.clients) {
      if (c.ws.readyState !== WebSocket.OPEN) {
        this.clients.delete(c);
        continue;
      }
      try { c.ws.send(data); }
      catch { this.clients.delete(c); }
    }
  }
}
