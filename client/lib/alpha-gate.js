import { buttonHtml } from "../ui/actions.js";

const KEY = "m3t4:alphaGate";
export const ALPHA_TOKEN_KEY = "m3t4:alphaToken";
const OVERLAY_ID = "alpha-overlay";
const LOCK_CLASS = "alpha-locked";

export async function installAlphaGate() {
  const expected = window.__M3T4_ALPHA_PASSWORD_SHA256__;
  if (!expected) return;
  if (sessionStorage.getItem(KEY) === expected) return;

  document.body.classList.add(LOCK_CLASS);
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.innerHTML = `
    <main class="page alpha-shell">
      <div class="page-header">
        <h1>m3t4 <small>closed alpha</small></h1>
      </div>
      <div class="panel">
        <div class="row">
          <input id="alpha-password" class="u-fill" type="password" placeholder="alpha password">
          ${buttonHtml({ id: "alpha-enter", variant: "primary", text: "enter", attrs: { title: "Acknowledge early-access and enter the site" } })}
        </div>
        <div id="alpha-error" class="error"></div>
      </div>
    </main>`;
  document.body.appendChild(overlay);

  await new Promise((resolve) => {
    const input = overlay.querySelector("#alpha-password");
    const button = overlay.querySelector("#alpha-enter");
    const error = overlay.querySelector("#alpha-error");

    async function submit() {
      const hash = await sha256Hex(input.value);
      if (hash !== expected) {
        error.textContent = "invalid alpha password";
        input.value = "";
        input.focus();
        return;
      }
      sessionStorage.setItem(KEY, expected);
      sessionStorage.setItem(ALPHA_TOKEN_KEY, input.value);
      overlay.remove();
      document.body.classList.remove(LOCK_CLASS);
      resolve();
    }

    button.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    input.focus();
  });
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
