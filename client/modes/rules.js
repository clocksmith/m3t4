// About mode — product/technology overview plus player-facing mechanics.
// Keep sensitive implementation internals out of this surface; players need
// to understand the arena and the trust boundary, not the source.

import gameCopy from "../content/game-copy.v1.json" with { type: "json" };
import { linkButtonHtml } from "../ui/actions.js";
import { escapeHtml } from "../ui/html.js";
import { contextCardHtml, pageHeaderHtml, disclosureHtml } from "../ui/shell.js";

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
  const firstSentence = body[0].split(/(?<=\.)\s+/)[0] ?? body[0];
  const rest = body[0].slice(firstSentence.length).trim();
  return contextCardHtml({
    className: "rules-card-feature",
    body: `
      <div class="context-card-kicker">${escapeHtml(about.title ?? "about")}</div>
      <div class="context-card-copy">
        <strong>${escapeHtml(firstSentence)}</strong>
        ${rest ? `<span>${escapeHtml(rest)}</span>` : ""}
      </div>`,
  });
}

function aboutDetailHtml(about) {
  const body = Array.isArray(about?.body) ? about.body.slice(1) : [];
  if (!body.length) return "";
  return `
    <section class="rules-about-copy" aria-label="About details">
      ${body.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
    </section>`;
}

function aboutLinksHtml(about) {
  const links = Array.isArray(about?.links) ? about.links : [];
  if (!links.length) return "";
  return `
    <section class="rules-related" aria-label="Related projects">
      ${links.map((link) => `
        <div class="rules-related-copy">
          <span>${escapeHtml(link.kicker ?? "shared browser inference")}</span>
          <strong>${escapeHtml(link.note ?? "")}</strong>
        </div>
        ${linkButtonHtml({
          href: link.href,
          text: link.cta ?? link.label,
          variant: "primary",
          attrs: {
            target: "_blank",
            rel: "noopener noreferrer",
            title: `Open ${link.label}`,
          },
        })}
      `).join("")}
    </section>`;
}

export function mount(root, { setStatus }) {
  setStatus("about");
  const rules = gameCopy.rules ?? {};
  const sections = Array.isArray(rules.sections) ? rules.sections : [];

  root.innerHTML = `
    <div class="page rules-page">
      ${pageHeaderHtml({
        title: rules.title ?? "Rules",
        subtitle: rules.subtitle ?? "",
        className: "rules-hero",
      })}

      ${aboutCardHtml(rules.about)}

      <div class="rules-rules-column">
        <div class="rules-section-label">Rules</div>
        <section class="rules-grid">
          ${sections.map(sectionHtml).join("")}
        </section>
      </div>
      ${disclosureHtml({ label: "Under the hood · policy search & compute", body: aboutDetailHtml(rules.about) + aboutLinksHtml(rules.about) })}
    </div>`;
}

export function unmount() {}
