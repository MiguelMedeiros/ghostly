import type { OutgoingHttpHeader, OutgoingHttpHeaders, ServerResponse } from "node:http";

/** A Cache-Control value with `no-transform` in it: the value as it was, the directive added once. */
export function noTransform(value: string | number | readonly string[] | undefined): string {
  const text = Array.isArray(value) ? value.join(", ") : value === undefined ? "" : String(value);
  if (/(^|,)\s*no-transform\s*(,|$)/i.test(text)) return text;
  return text.trim() ? `${text}, no-transform` : "no-transform";
}

type Head = ServerResponse["writeHead"];
const MARK = Symbol.for("ghostly.noTransform");

/**
 * Makes every answer of this server say `no-transform`, added to the Cache-Control it carries as it is sent: Next.js
 * sets that header itself, page by page (a year for a prerendered page, none for one rendered per request), and one set
 * in next.config.ts would take its place on every page. Once per class.
 */
export function withNoTransform(Response: { prototype: ServerResponse }): void {
  const proto = Response.prototype as ServerResponse & { [MARK]?: true };
  if (proto[MARK]) return;
  proto[MARK] = true;
  const writeHead = proto.writeHead as (this: ServerResponse, ...args: unknown[]) => ServerResponse;
  proto.writeHead = function (this: ServerResponse, ...args: unknown[]) {
    // writeHead(status, [reason], [headers]): headers given here take the place of the ones set before.
    const given = args.find((arg, i) => i > 0 && arg !== null && typeof arg === "object") as OutgoingHttpHeaders | OutgoingHttpHeader[] | undefined;
    if (Array.isArray(given)) {
      const at = given.findIndex((item, i) => i % 2 === 0 && String(item).toLowerCase() === "cache-control");
      if (at >= 0) given[at + 1] = noTransform(given[at + 1] as string);
      else if (!this.headersSent) this.setHeader("Cache-Control", noTransform(this.getHeader("Cache-Control")));
    } else {
      const key = given ? Object.keys(given).find((name) => name.toLowerCase() === "cache-control") : undefined;
      if (key) given![key] = noTransform(given![key]);
      else if (!this.headersSent) this.setHeader("Cache-Control", noTransform(this.getHeader("Cache-Control")));
    }
    return writeHead.apply(this, args);
  } as Head;
}
