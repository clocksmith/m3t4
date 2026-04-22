import { classNames, escapeHtml } from "./html.js";

function attrsHtml(attrs = {}) {
  return Object.entries(attrs)
    .map(([key, value]) => {
      if (value === false || value == null) return "";
      if (value === true) return ` ${key}`;
      return ` ${key}="${escapeHtml(value)}"`;
    })
    .join("");
}

export function actionClass({ variant = "", className = "" } = {}) {
  return classNames("ui-button", variant ? `is-${variant}` : "", className);
}

export function buttonHtml({ id = "", className = "", variant = "", type = "button", attrs = {}, text = "" }) {
  const htmlAttrs = {
    type,
    id: id || null,
    class: actionClass({ variant, className }),
    ...attrs,
  };
  return `<button${attrsHtml(htmlAttrs)}>${escapeHtml(text)}</button>`;
}

export function linkButtonHtml({ href = "#", className = "", variant = "", attrs = {}, text = "" }) {
  const htmlAttrs = {
    href,
    class: actionClass({ variant, className }),
    ...attrs,
  };
  return `<a${attrsHtml(htmlAttrs)}>${escapeHtml(text)}</a>`;
}
