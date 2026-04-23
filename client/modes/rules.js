// About mode — product/technology overview plus player-facing mechanics.
// Keep sensitive implementation internals out of this surface; players need
// to understand the arena and the trust boundary, not the source.

import gameCopy from "../content/game-copy.v1.json" with { type: "json" };
import { escapeHtml } from "../ui/html.js";
import { linkButtonHtml } from "../ui/actions.js";
import { contextCardHtml, pageHeaderHtml } from "../ui/shell.js";

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
    kicker: about.title ?? "about",
    strong: firstSentence,
    copy: rest,
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

function computeLinkCardHtml() {
  return contextCardHtml({
    className: "rules-card-compute-link",
    body: `
      <div class="context-card-kicker">opt-in compute</div>
      <div class="context-card-copy">
        <strong>Compute controls and public receipt stats live on the Compute page.</strong>
        <span>Opt in, set pause policy, and watch accepted receipts accumulate.</span>
      </div>
      <div class="rules-card-compute-action">
        ${linkButtonHtml({
          href: "/compute",
          variant: "primary",
          text: "open Compute",
          attrs: { title: "Go to the Compute page to opt in and see receipts" },
        })}
      </div>`,
  });
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
        action: linkButtonHtml({ href: "/spectate", variant: "danger", text: "watch live", attrs: { title: "Leave this page and watch live matches" } }),
      })}

      ${aboutCardHtml(rules.about)}
      ${aboutDetailHtml(rules.about)}
      ${computeLinkCardHtml()}

      <div class="rules-rules-column">
        <div class="rules-section-label">Rules</div>
        <section class="rules-grid">
          ${sections.map(sectionHtml).join("")}
        </section>
      </div>
    </div>`;
}

export function unmount() {}
