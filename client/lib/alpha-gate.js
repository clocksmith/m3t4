const KEY = "m3t4:alphaGate";
export const ALPHA_TOKEN_KEY = "m3t4:alphaToken";

export async function installAlphaGate() {
  const expected = window.__M3T4_ALPHA_PASSWORD_SHA256__;
  if (!expected) return;
  if (sessionStorage.getItem(KEY) === expected) return;

  document.body.innerHTML = `
    <main class="page alpha-shell">
      <div class="page-header">
        <h1>m3t4 <small>closed alpha</small></h1>
      </div>
      <div class="panel">
        <div class="row">
          <input id="alpha-password" class="u-fill" type="password" placeholder="alpha password">
          <button id="alpha-enter" class="primary">enter</button>
        </div>
        <div id="alpha-error" class="error"></div>
      </div>
    </main>`;

  await new Promise((resolve) => {
    const input = document.getElementById("alpha-password");
    const button = document.getElementById("alpha-enter");
    const error = document.getElementById("alpha-error");

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
      document.body.innerHTML = `
        <header id="topnav">
          <div class="brand">
            <a href="#intro" class="logo">m3t4<span class="logo-caret">.ai</span></a>
          </div>
          <nav>
            <a href="#intro" data-route="intro">intro</a>
            <a href="#build" data-route="build">build</a>
            <a href="#spectate" data-route="spectate">live</a>
            <a href="#profile" data-route="profile">profile</a>
            <a href="#duel" data-route="duel" data-feature="p2pDuel" hidden>duel</a>
            <a href="#rules" data-route="rules">rules</a>
          </nav>
          <div id="whoami" class="whoami"></div>
        </header>
        <main id="app"></main>
        <footer id="bottom">
          <span id="status">—</span>
          <span class="spacer"></span>
          <a href="https://github.com/m3t4-ai" target="_blank" rel="noreferrer">github</a>
        </footer>`;
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
