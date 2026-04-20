import http from "node:http";
import { CONFIG } from "./config.js";

export function corsHeaders(): Record<string, string> {
  const allowOrigin = CONFIG.isProd ? (CONFIG.corsOrigins[0] ?? "https://m3t4.ai") : "*";
  return {
    "access-control-allow-origin": allowOrigin,
    "vary": "Origin",
  };
}

export function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, {
    "content-type": "application/json",
    ...corsHeaders(),
  });
  res.end(JSON.stringify(body));
}
