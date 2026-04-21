// Auth wrapper. Local dev can pick a UID. Production uses Firebase Auth
// when window.__M3T4_FIREBASE_CONFIG__ is supplied by deploy-time config.

import { ALPHA_TOKEN_KEY } from "./alpha-gate.js";

const KEY_UID = "m3t4:uid";
const KEY_HANDLE = "m3t4:handle";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", ""]);
const IS_LOCAL = typeof location === "undefined" || LOCAL_HOSTS.has(location.hostname);

function configuredAuthMode() {
  const requested = window.__M3T4_AUTH_MODE__ || (IS_LOCAL ? "dev" : "firebase");
  if (!IS_LOCAL && requested === "dev") return "firebase";
  return requested;
}

class DevAuth {
  constructor() {
    this._listeners = new Set();
    this.mode = "dev";
  }

  user() {
    const uid = localStorage.getItem(KEY_UID);
    if (!uid) return null;
    return { uid, handle: localStorage.getItem(KEY_HANDLE) || null };
  }

  async signIn(uid) {
    if (!/^[a-zA-Z0-9_-]{3,64}$/.test(uid)) throw new Error("uid must be 3-64 chars");
    localStorage.setItem(KEY_UID, uid);
    this._emit();
    return this.user();
  }

  signOut() {
    localStorage.removeItem(KEY_UID);
    localStorage.removeItem(KEY_HANDLE);
    this._emit();
  }

  setHandle(h) {
    const next = h ? String(h) : "";
    if ((localStorage.getItem(KEY_HANDLE) || "") === next) return;
    if (next) localStorage.setItem(KEY_HANDLE, next);
    else localStorage.removeItem(KEY_HANDLE);
    this._emit();
  }

  async token() {
    // Dev mode: bearer token IS the UID. Server's dev-mode verifier accepts it.
    return localStorage.getItem(KEY_UID) || "";
  }

  error() { return null; }
  onChange(cb) { this._listeners.add(cb); return () => this._listeners.delete(cb); }
  _emit() { for (const cb of this._listeners) try { cb(); } catch {} }
}

class AlphaTokenAuth extends DevAuth {
  constructor() {
    super();
    this.mode = "alpha-token";
  }

  async token() {
    const uid = localStorage.getItem(KEY_UID) || "";
    const secret = sessionStorage.getItem(ALPHA_TOKEN_KEY);
    if (!secret) throw new Error("alpha token missing; pass the alpha password gate first");
    return `${uid}:${secret}`;
  }
}

class FirebaseAuth {
  constructor(config) {
    this.mode = "firebase";
    this._listeners = new Set();
    this._user = null;
    this._error = null;
    this._auth = null;
    this._sdk = null;
    this._ready = this._init(config);
  }

  async _init(config) {
    try {
      if (!config?.apiKey || !config?.authDomain || !config?.projectId || !config?.appId) {
        throw new Error("Firebase client config missing");
      }
      const version = window.__M3T4_FIREBASE_SDK_VERSION__ || "10.13.2";
      const [appSdk, authSdk] = await Promise.all([
        import(`https://www.gstatic.com/firebasejs/${version}/firebase-app.js`),
        import(`https://www.gstatic.com/firebasejs/${version}/firebase-auth.js`),
      ]);
      const app = appSdk.getApps().length ? appSdk.getApps()[0] : appSdk.initializeApp(config);
      this._auth = authSdk.getAuth(app);
      this._sdk = authSdk;
      authSdk.onAuthStateChanged(this._auth, (user) => {
        this._user = user;
        this._emit();
      });
    } catch (e) {
      this._error = e instanceof Error ? e : new Error(String(e));
      this._emit();
    }
  }

  user() {
    if (!this._user) return null;
    return {
      uid: this._user.uid,
      email: this._user.email || null,
      displayName: this._user.displayName || null,
      handle: localStorage.getItem(KEY_HANDLE) || null,
    };
  }

  async signIn(provider = "google") {
    await this._ready;
    if (this._error) throw this._error;
    const Provider = provider === "github"
      ? this._sdk.GithubAuthProvider
      : this._sdk.GoogleAuthProvider;
    await this._sdk.signInWithPopup(this._auth, new Provider());
    return this.user();
  }

  async signOut() {
    await this._ready;
    if (this._auth) await this._sdk.signOut(this._auth);
    localStorage.removeItem(KEY_HANDLE);
    this._emit();
  }

  setHandle(h) {
    const next = h ? String(h) : "";
    if ((localStorage.getItem(KEY_HANDLE) || "") === next) return;
    if (next) localStorage.setItem(KEY_HANDLE, next);
    else localStorage.removeItem(KEY_HANDLE);
    this._emit();
  }

  async token() {
    await this._ready;
    if (this._error) throw this._error;
    if (!this._auth?.currentUser) throw new Error("not signed in");
    return this._auth.currentUser.getIdToken();
  }

  error() { return this._error?.message || null; }
  onChange(cb) { this._listeners.add(cb); return () => this._listeners.delete(cb); }
  _emit() { for (const cb of this._listeners) try { cb(); } catch {} }
}

const mode = configuredAuthMode();
export const auth = mode === "dev"
  ? new DevAuth()
  : mode === "alpha-token"
    ? new AlphaTokenAuth()
    : new FirebaseAuth(window.__M3T4_FIREBASE_CONFIG__);
