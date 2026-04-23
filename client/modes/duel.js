// Disabled duel shell.
//
// The old p2p duel implementation imported the canonical sim and brain into
// the browser so both peers could run lockstep WebRTC matches. That is not a
// production-safe shape: any module the browser executes can be downloaded.
//
// Keep this route intentionally inert until duel is rebuilt like Build preview:
// client submits config choices, server runs canonical simulation, client only
// renders sanitized replay frames.

import { navigateTo } from "../navigate.js";

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function go(route) {
  const normalized = String(route || "").replace(/^#/, "");
  navigateTo(normalized);
}

export function renderDuel(root, { setStatus } = {}) {
  setStatus?.("duel quarantined");
  root.innerHTML = "";

  const panel = el(
    "section",
    { class: "duel-panel mode-panel" },
    el("p", { class: "eyebrow" }, "P2P DUEL QUARANTINED"),
    el("h2", {}, "Manual lockstep was a liability."),
    el(
      "p",
      { class: "duel-hint" },
      "The browser is no longer trusted with the brain. The arena accepts policy, ",
      "the server moves the bodies, and spectators get the sanitized receipt."
    ),
    el(
      "p",
      { class: "duel-hint" },
      "This route will come back only as a server-authoritative duel surface: ",
      "config in, replay frames out, no canonical strategy code shipped to clients."
    ),
    el(
      "div",
      { class: "duel-actions" },
      el("button", { type: "button", class: "ui-button", onclick: () => go("build"), title: "Open Tune and edit policy settings" }, "author policy"),
      el("button", { type: "button", class: "ui-button", onclick: () => go("spectate"), title: "Open Live and watch sanitized replay receipts" }, "watch receipts"),
      el("button", { type: "button", class: "ui-button", onclick: () => go("rules"), title: "Open About and read the system framing" }, "read about")
    )
  );

  root.appendChild(panel);
}

export function mount(root, context = {}) {
  renderDuel(root, context);
}

export function unmount() {}
