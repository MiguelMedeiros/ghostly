import { Fragment, isValidElement, type ReactNode } from "react";

const VOID = new Set(["area", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const ATTRIBUTE: Record<string, string> = { className: "class", htmlFor: "for", tabIndex: "tabindex" };
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const css = (style: Record<string, unknown>) =>
  Object.entries(style)
    .filter(([, value]) => value != null && value !== "")
    .map(([key, value]) => `${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${value}`)
    .join(";");

/**
 * The HTML of a tree of plain elements and server-only function components (no hooks, no client components), as
 * React would write it. A static article put in the page as this one string costs the page's flight data that
 * string, not every element of it again.
 */
export function staticHtml(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return escape(String(node));
  if (Array.isArray(node)) return node.map(staticHtml).join("");
  if (!isValidElement<Record<string, unknown>>(node)) throw new Error("staticHtml: not a React node");
  const { type, props } = node;
  const children = props.children as ReactNode;
  if (type === Fragment) return staticHtml(children);
  if (typeof type === "function") return staticHtml((type as (props: object) => ReactNode)(props));
  if (typeof type !== "string") throw new Error("staticHtml: only plain elements and function components");
  let attributes = "";
  for (const [key, value] of Object.entries(props)) {
    if (key === "children" || value == null || value === false) continue;
    const name = ATTRIBUTE[key] ?? key;
    if (key === "style") attributes += ` style="${escape(css(value as Record<string, unknown>))}"`;
    // React writes aria-* and data-* booleans as "true"; other boolean attributes (open, checked) stand alone.
    else if (value === true && !/^(aria|data)-/.test(name)) attributes += ` ${name}=""`;
    else attributes += ` ${name}="${escape(String(value))}"`;
  }
  return VOID.has(type) ? `<${type}${attributes}/>` : `<${type}${attributes}>${staticHtml(children)}</${type}>`;
}
