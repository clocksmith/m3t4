import type { IncomingMessage, ServerResponse } from "node:http";

export function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-plasma-admin-token,x-worker-session-token,x-webrtc-session-token,x-webrtc-pair-token",
  });
  res.end(JSON.stringify(body));
}

export function html(res: ServerResponse, code: number, body: string): void {
  res.writeHead(code, {
    "content-type": "text/html; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  res.end(body);
}

export async function readJson<T>(req: IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
