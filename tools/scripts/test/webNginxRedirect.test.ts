import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

/**
 * app.ghostly.tools never sends a browser to its http:// address. nginx listens on :80 behind Cloudflare's tunnel and
 * writes a redirect to a path (`return 303 /`) as an absolute URL with its own scheme: `http://app.ghostly.tools/`, a
 * plain-http hop the edge then sends back to https. With absolute_redirect off it sends the path, which the browser
 * resolves against the https address it used.
 */
const conf = readFileSync(join(import.meta.dirname, "../../../apps/web/nginx.conf"), "utf8")
  .split("\n")
  .map((line) => line.replace(/#.*/, ""))
  .join("\n");

/** The http block's own lines: before the first server, so nginx-services.conf's server has them too. */
const http = conf.slice(0, conf.search(/^server\s*\{/m));

it("writes a redirect to a path as that path, for every server", () => {
  expect(http.match(/^absolute_redirect\s+([^;]*);/m)?.[1].trim()).toBe("off");
});

it("redirects only to a path or to an https:// address", () => {
  const redirects = [...conf.matchAll(/return\s+30\d\s+([^;]+);/g)].map((m) => m[1].trim());
  expect(redirects).toContain("/");
  for (const target of redirects) expect(target, target).toMatch(/^(\/|https:\/\/)/);
});
