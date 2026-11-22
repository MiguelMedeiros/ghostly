import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

/**
 * app.ghostly.tools compresses its own answers. Every answer says no-transform (apps/web/nginx.conf), which keeps
 * Cloudflare from writing into the pages and also from compressing them: without gzip here the app's scripts and
 * styles (about 10 MB, 3.5 MB compressed) travel as they are.
 */
const conf = readFileSync(join(import.meta.dirname, "../../../apps/web/nginx.conf"), "utf8")
  .split("\n")
  .map((line) => line.replace(/#.*/, ""))
  .join("\n");

/** The http block's own lines: before the first server, so nginx-services.conf's server has them too. */
const http = conf.slice(0, conf.search(/^server\s*\{/m));
const directive = (name: string) => http.match(new RegExp(`^${name}\\s+([^;]*);`, "m"))?.[1].trim().split(/\s+/);

it("compresses for every server", () => {
  expect(directive("gzip")).toEqual(["on"]);
  expect(directive("gzip_vary")).toEqual(["on"]);
});

it("compresses behind Cloudflare's tunnel too (off by default for a request that came through a proxy)", () => {
  expect(directive("gzip_proxied")).toEqual(["any"]);
});

it("compresses the scripts, styles and data the build writes, as the image's mime.types names them", () => {
  const types = directive("gzip_types") ?? [];
  for (const type of ["application/javascript", "text/javascript", "text/css", "application/json", "application/manifest+json", "application/wasm", "image/svg+xml"]) {
    expect(types, type).toContain(type);
  }
});
