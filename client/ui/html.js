export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function classNames(...values) {
  return values.flat().filter(Boolean).join(" ");
}

export function joinHtml(items) {
  return (items ?? []).filter(Boolean).join("");
}
