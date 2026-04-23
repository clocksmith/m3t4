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
    title: attrs.title ?? (text ? text : null),
    ...attrs,
  };
  return `<button${attrsHtml(htmlAttrs)}>${escapeHtml(text)}</button>`;
}

export function linkButtonHtml({ href = "#", className = "", variant = "", attrs = {}, text = "" }) {
  const htmlAttrs = {
    href,
    class: actionClass({ variant, className }),
    title: attrs.title ?? (text ? text : null),
    ...attrs,
  };
  return `<a${attrsHtml(htmlAttrs)}>${escapeHtml(text)}</a>`;
}

export function toggleSwitchHtml({ id = "", label = "", title = "", className = "", checked = false, inputAttrs = {} }) {
  const wrapperClass = classNames("ui-toggle", className);
  const wrapperAttrs = attrsHtml({
    class: wrapperClass,
    title: title || null,
    for: id || null,
  });
  const inputHtmlAttrs = attrsHtml({
    type: "checkbox",
    id: id || null,
    class: "ui-toggle-input",
    ...inputAttrs,
    ...(checked ? { checked: true } : {}),
  });
  return `<label${wrapperAttrs}>
      <input${inputHtmlAttrs}>
      <span class="ui-toggle-track" aria-hidden="true"><span class="ui-toggle-thumb"></span></span>
      <span class="ui-toggle-label">${escapeHtml(label)}</span>
    </label>`;
}

export function chipHtml({ variant = "default", label = "", title = "" }) {
  const classes = classNames("ui-chip", variant ? `is-${variant}` : "");
  const attrs = attrsHtml({ class: classes, title: title || null });
  return `<span${attrs}>${escapeHtml(label)}</span>`;
}
