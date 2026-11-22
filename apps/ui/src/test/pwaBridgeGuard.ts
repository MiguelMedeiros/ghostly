import { vi } from "vitest";
import { CLIPBOARD_GUARD_SCRIPT } from "@ghostly/core";

/**
 * The clipboard guard the bridge (apps/web/src/svc/bridge.ts) runs inline, as a browser whose policy allows it would
 * run it: happy-dom runs no script, so what the bridge reads afterwards (the document's mark, `execCommand` fixed in
 * place) is left as the guard leaves it, once the bridge puts the script in the page. Once per file: both stay fixed.
 */
export function runBridgeGuard(): void {
  const append = Element.prototype.append;
  vi.spyOn(document.head, "append").mockImplementation(function (this: Element, ...nodes) {
    append.apply(this, nodes);
    if (nodes.some((node) => node instanceof HTMLScriptElement && node.textContent === CLIPBOARD_GUARD_SCRIPT) && !Object.getOwnPropertyDescriptor(document, "ghostlyClipboardGuard")) {
      Object.defineProperty(document, "ghostlyClipboardGuard", { value: true });
      Object.defineProperty(Object.getPrototypeOf(document) as object, "execCommand", { value: () => false });
    }
  });
}
