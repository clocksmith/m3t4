import { escapeHtml } from "./html.js";

export function statListHtml(rows) {
  return `
    <dl class="stat-list">
      ${rows.map((row) => statRowHtml(row)).join("")}
    </dl>`;
}

export function statRowHtml({ label, id = "", className = "", value = "—" }) {
  const idAttr = id ? ` id="${escapeHtml(id)}"` : "";
  const classAttr = className ? ` class="${escapeHtml(className)}"` : "";
  return `
    <div class="stat-row">
      <dt>${escapeHtml(label)}</dt>
      <dd${idAttr}${classAttr}>${escapeHtml(value)}</dd>
    </div>`;
}
