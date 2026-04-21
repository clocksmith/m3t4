// About mode — product/technology overview plus player-facing mechanics.
// Keep sensitive implementation internals out of this surface; players need
// to understand the arena and the trust boundary, not the source.

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

function aboutCardHtml(about) {
  const body = Array.isArray(about?.body) ? about.body : [];
  if (!body.length) return "";
  return `
    <article class="context-card rules-card-feature">
      <div class="context-card-kicker">${escapeHtml(about.title ?? "About")}</div>
      <p>${escapeHtml(body[0])}</p>
    </article>`;
}

function aboutDetailHtml(about) {
  const body = Array.isArray(about?.body) ? about.body.slice(1) : [];
  if (!body.length) return "";
  return `
    <section class="rules-about-copy" aria-label="About details">
      ${body.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
    </section>`;
}

export function mount(root, { setStatus }) {
  setStatus("about");
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

      ${aboutCardHtml(rules.about)}

      <div class="rules-main-layout">
        ${aboutDetailHtml(rules.about)}
        <div class="rules-rules-column">
          <div class="rules-section-label">Rules</div>
          <section class="rules-grid">
            ${sections.map(sectionHtml).join("")}
          </section>
        </div>
      </div>
    </div>`;
}

export function unmount() {}
