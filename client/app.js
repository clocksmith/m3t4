// Hash router. Each mode module exports { mount(el), unmount() }.
// Only one mode active at a time.

import * as spectate from "./modes/spectate.js";
import * as practice from "./modes/practice.js";
import * as build from "./modes/build.js";
import * as submit from "./modes/submit.js";
import * as duel from "./modes/duel.js";
import { auth } from "./lib/auth.js";

const MODES = { spectate, practice, build, submit, duel };
const DEFAULT_MODE = "spectate";

const appEl = document.getElementById("app");
const navLinks = Array.from(document.querySelectorAll("#topnav nav a"));
const whoamiEl = document.getElementById("whoami");
const statusEl = document.getElementById("status");

let current = null;

function render() {
  const hash = (window.location.hash || "#" + DEFAULT_MODE).slice(1);
  const [name] = hash.split("?");
  const mode = MODES[name] ?? MODES[DEFAULT_MODE];

  navLinks.forEach((a) => {
    a.classList.toggle("active", a.dataset.route === (name in MODES ? name : DEFAULT_MODE));
  });

  if (current && current.unmount) current.unmount();
  appEl.innerHTML = "";
  current = mode;
  mode.mount(appEl, { setStatus: (s) => (statusEl.textContent = s) });
}

function renderWhoami() {
  const u = auth.user();
  if (u) {
    whoamiEl.innerHTML = `<span>${u.handle ? "@" + u.handle : u.uid}</span>  <a href="#" id="signout">sign out</a>`;
    document.getElementById("signout")?.addEventListener("click", (e) => {
      e.preventDefault();
      auth.signOut();
      renderWhoami();
    });
  } else {
    whoamiEl.innerHTML = `<a href="#submit">sign in</a>`;
  }
}

auth.onChange(renderWhoami);
renderWhoami();

window.addEventListener("hashchange", render);
render();
