import { classNames, escapeHtml } from "./html.js";

export function pageHeaderHtml({ title, subtitle = "", action = "", className = "" }) {
  return `
    <div class="${classNames("page-header-row", className)}">
      <div class="page-title-stack">
        <h1 class="page-title">${escapeHtml(title)}</h1>
        ${subtitle ? `<div class="page-subtitle tight">${escapeHtml(subtitle)}</div>` : ""}
      </div>
      ${action}
    </div>`;
}

export function contextCardHtml({ className = "", kicker = "", strong = "", copy = "", body = "", autoHeight = true }) {
  const content = body || `
    <div class="context-card-kicker">${escapeHtml(kicker)}</div>
    <div class="context-card-copy">
      ${strong ? `<strong>${escapeHtml(strong)}</strong>` : ""}
      ${copy ? `<span>${escapeHtml(copy)}</span>` : ""}
    </div>`;
  return `
    <section class="${classNames("context-card", autoHeight ? "context-card--auto" : "", className)}">
      ${content}
    </section>`;
}

export function panelHtml({ className = "", title = "", body = "" }) {
  return `
    <section class="${classNames("panel", className)}">
      ${title ? `<h3>${escapeHtml(title)}</h3>` : ""}
      ${body}
    </section>`;
}

// Contents are trusted component markup; labels and attributes are escaped.
export function disclosureHtml({ label, body, className = "", open = false }) {
  return `<details class="${classNames("ui-disclosure", className)}"${open ? " open" : ""}>
    <summary>${escapeHtml(label)}</summary><div class="ui-disclosure-body">${body}</div>
  </details>`;
}

export function workshopHeaderHtml({ active = "tune", subtitle = "", action = "" } = {}) {
  return pageHeaderHtml({ title: "Workshop", subtitle, action }) + `
    <nav class="ui-tabs" aria-label="Workshop">
      ${[["tune", "Tune & test"], ["roster", "Saved fighters"]].map(([route, label]) =>
        `<a href="/${route}"${active === route ? ' aria-current="page"' : ""}>${label}</a>`).join("")}
    </nav>`;
}
