// Thin fetch wrappers over the m3t4 arena REST API.
// Server origin comes from window.__M3T4_API_ORIGIN__ or defaults to dev.

export const API_ORIGIN =
  (typeof window !== "undefined" && window.__M3T4_API_ORIGIN__) ||
  "http://localhost:7777";
export const WS_ORIGIN =
  (typeof window !== "undefined" && window.__M3T4_WS_ORIGIN__) ||
  API_ORIGIN.replace(/^http/, "ws");

async function handle(res) {
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(body?.error || `http ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export async function status() {
  return handle(await fetch(API_ORIGIN + "/api/status"));
}

export async function leaderboard(limit = 50) {
  return handle(await fetch(API_ORIGIN + "/api/leaderboard?limit=" + limit));
}

export async function leaderboardPage({ limit = 25, offset = 0 } = {}) {
  const params = new URLSearchParams({
    page: "1",
    limit: String(limit),
    offset: String(offset),
  });
  const body = await handle(await fetch(`${API_ORIGIN}/api/leaderboard?${params}`));
  if (!body || !Array.isArray(body.rows)) throw new Error("invalid leaderboard response");
  return body;
}

export async function getStable(uid) {
  return handle(await fetch(API_ORIGIN + "/api/stables/" + encodeURIComponent(uid)));
}

export async function getMyStable(token) {
  return handle(await fetch(API_ORIGIN + "/api/me/stable", {
    headers: { authorization: "Bearer " + token },
  }));
}

export async function claimHandle(token, handleStr) {
  return handle(await fetch(API_ORIGIN + "/api/handle", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ handle: handleStr }),
  }));
}

export async function submitSlot(token, slotIdx, config, name, cosmetics) {
  return handle(await fetch(API_ORIGIN + "/api/ranked/submit", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ slotIdx, config, name, cosmetics }),
  }));
}

export async function simulateBuildPreview(payload) {
  return handle(await fetch(API_ORIGIN + "/api/build/simulate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }));
}
