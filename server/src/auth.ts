// Auth adapter. Two modes:
//   1. "dev" — accepts any bearer token, uses it as the UID. Local only.
//   2. "firebase" — verifies Firebase ID token via Admin SDK.
//
// Select via AUTH_MODE env var.

const MODE = process.env.AUTH_MODE ?? (process.env.NODE_ENV === "production" ? "firebase" : "dev");
if (process.env.NODE_ENV === "production" && MODE === "dev") {
  throw new Error("AUTH_MODE=dev is not allowed in production");
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

async function getVerifier() {
  if (verifyFn) return verifyFn;
  verifyFn = MODE === "firebase" ? firebaseVerify : devVerify;
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
