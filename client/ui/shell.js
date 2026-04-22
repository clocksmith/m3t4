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

export function contextCardHtml({ className = "", kicker = "", strong = "", copy = "", body = "" }) {
  const content = body || `
    <div class="context-card-kicker">${escapeHtml(kicker)}</div>
    <div class="context-card-copy">
      ${strong ? `<strong>${escapeHtml(strong)}</strong>` : ""}
      ${copy ? `<span>${escapeHtml(copy)}</span>` : ""}
    </div>`;
  return `
    <section class="${classNames("context-card", className)}">
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
