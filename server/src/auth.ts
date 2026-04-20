// Auth adapter. Three modes:
//   1. "dev" — accepts any bearer token, uses it as the UID. Local only.
//   2. "firebase" — verifies Firebase ID token via Admin SDK.
//   3. "alpha-token" — closed-alpha pre-shared token, formatted
//      "<uid>:<token>". Allowed in production; dev mode is not.
//
// Select via AUTH_MODE env var.

import crypto from "node:crypto";

const MODE = process.env.AUTH_MODE ?? (process.env.NODE_ENV === "production" ? "firebase" : "dev");
if (process.env.NODE_ENV === "production" && MODE === "dev") {
  throw new Error("AUTH_MODE=dev is not allowed in production");
}
if (!["dev", "firebase", "alpha-token"].includes(MODE)) {
  throw new Error("AUTH_MODE must be dev, firebase, or alpha-token");
}
if (MODE === "alpha-token" && !process.env.M3T4_ALPHA_TOKEN) {
  throw new Error("M3T4_ALPHA_TOKEN is required when AUTH_MODE=alpha-token");
}

let verifyFn: ((token: string) => Promise<{ uid: string; email?: string }>) | null = null;

async function devVerify(token: string): Promise<{ uid: string }> {
  // Token is the UID directly. For local testing.
  if (!token || !/^[a-zA-Z0-9_-]{3,64}$/.test(token)) {
    throw new Error("invalid dev token");
  }
  return { uid: token };
}

async function firebaseVerify(token: string): Promise<{ uid: string; email?: string }> {
  const { getAuth } = await import("firebase-admin/auth");
  const { initializeApp, getApps, applicationDefault } = await import("firebase-admin/app");
  if (getApps().length === 0) initializeApp({ credential: applicationDefault() });
  const decoded = await getAuth().verifyIdToken(token);
  return { uid: decoded.uid, email: decoded.email };
}

async function alphaTokenVerify(token: string): Promise<{ uid: string }> {
  const sep = token.indexOf(":");
  if (sep <= 0) throw new Error("invalid alpha token");
  const uid = token.slice(0, sep);
  const secret = token.slice(sep + 1);
  if (!/^[a-zA-Z0-9_-]{3,64}$/.test(uid)) throw new Error("invalid alpha uid");
  const expected = process.env.M3T4_ALPHA_TOKEN ?? "";
  const got = Buffer.from(secret);
  const want = Buffer.from(expected);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    throw new Error("invalid alpha token");
  }
  const allowlist = (process.env.M3T4_ALPHA_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowlist.length > 0 && !allowlist.includes(uid)) {
    throw new Error("alpha uid not invited");
  }
  return { uid };
}

async function getVerifier() {
  if (verifyFn) return verifyFn;
  if (MODE === "firebase") verifyFn = firebaseVerify;
  else if (MODE === "alpha-token") verifyFn = alphaTokenVerify;
  else verifyFn = devVerify;
  return verifyFn;
}

export async function verifyAuth(authHeader: string | undefined): Promise<{ uid: string; email?: string }> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error("missing bearer token");
  }
  const token = authHeader.slice(7);
  const v = await getVerifier();
  return v(token);
}

export const AUTH_MODE = MODE;
