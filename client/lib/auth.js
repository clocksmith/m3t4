// Auth wrapper. Dev mode: user picks a UID, stored in localStorage. Prod
// mode (later): Firebase Auth with Google + GitHub providers.

const KEY_UID = "m3t4:uid";
const KEY_HANDLE = "m3t4:handle";

class DevAuth {
  constructor() {
    this._listeners = new Set();
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
    localStorage.setItem(KEY_HANDLE, h);
    this._emit();
  }

  token() {
    // Dev mode: bearer token IS the UID. Server's dev-mode verifier accepts it.
    return localStorage.getItem(KEY_UID) || "";
  }

  onChange(cb) { this._listeners.add(cb); return () => this._listeners.delete(cb); }
  _emit() { for (const cb of this._listeners) try { cb(); } catch {} }
}

// Single instance
export const auth = new DevAuth();

// Future: wire Firebase here, swap via window.__M3T4_AUTH_MODE__
