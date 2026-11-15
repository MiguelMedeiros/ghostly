/**
 * A link to another site opens outside the app on every platform. A browser page opens a new tab from the link itself;
 * the Desktop WebView opens none (WKWebView, as Tauri sets it up, drops a new-window request), so there the link hands
 * the address to the system browser (`open_web_link`). Every such link takes `externalLinkProps` from
 * apps/ui/src/lib/externalLink.ts, and this rule refuses `_blank` spelled anywhere else: `target="_blank"`,
 * `target={"_blank"}`, `target: "_blank"`, `window.open(url, "_blank")`, in any case.
 */

/** The text parts of a string or template literal: each asks for a new window when it is `_blank`. */
const blank =(parts) => parts.some((part) => typeof part === "string" && part.trim().toLowerCase() === "_blank");

export default {
  meta: {
    type: "problem",
    docs: { description: "A new window is asked for only through externalLinkProps (apps/ui/src/lib/externalLink.ts)" },
    schema: [],
    messages: { blank: "The Desktop WebView opens no new window: use externalLinkProps from apps/ui/src/lib/externalLink.ts." },
  },
  create(context) {
    const check = (node, parts) => { if (blank(parts)) context.report({ node, messageId: "blank" }); };
    return {
      Literal: (node) => check(node, [node.value]),
      TemplateLiteral: (node) => check(node, node.quasis.map((quasi) => quasi.value.cooked)),
    };
  },
};
