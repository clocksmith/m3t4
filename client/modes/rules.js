// Rules mode — player-facing mechanics only. Keep implementation internals
// out of this surface; players need to understand the arena, not the source.

import gameCopy from "../content/game-copy.v1.json" with { type: "json" };

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sectionHtml(section) {
  const body = Array.isArray(section.body) ? section.body : [];
  return `
    <article class="rules-card">
      <h2>${escapeHtml(section.title)}</h2>
      <ul>
        ${body.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}
      </ul>
    </article>`;
}

export function mount(root, { setStatus }) {
  setStatus("rules");
  const rules = gameCopy.rules ?? {};
  const sections = Array.isArray(rules.sections) ? rules.sections : [];

  root.innerHTML = `
    <div class="page rules-page">
      <div class="page-header-row rules-hero">
        <div class="page-title-stack">
          <h1 class="page-title">${escapeHtml(rules.title ?? "Rules")}</h1>
          <div class="page-subtitle tight">${escapeHtml(rules.subtitle ?? "")}</div>
        </div>
        <a class="buttonish primary" href="#spectate">watch live</a>
      </div>

      <section class="rules-summary">
        ${escapeHtml(rules.summary ?? "")}
      </section>

      <section class="rules-grid">
        ${sections.map(sectionHtml).join("")}
      </section>
    </div>`;
}

export function unmount() {}
