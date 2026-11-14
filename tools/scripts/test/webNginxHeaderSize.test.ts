import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

/**
 * apps/web/nginx.conf (the app) and nginx-services.conf (a contact's app's bridge) answer a request whose headers are
 * over nginx's limit as any other one. A contact's app may set cookies for a domain above its own origin, which every
 * request to the services host (and, under the app's own site, to the app) then carries: nginx's own answer to those,
 * a 400, would keep the bridge, its clear of those cookies and the app from loading until the person clears the site.
 */
const servers = ["nginx.conf", "nginx-services.conf"].flatMap((file) => {
  const conf = readFileSync(join(import.meta.dirname, "../../../apps/web", file), "utf8")
    .split("\n")
    .map((line) => line.replace(/#.*/, ""))
    .join("\n");
  return conf.split(/^server\s*\{/m).slice(1).map((body) => ({ file, body }));
});

/** The body of `location <name> { ... }` (one level of nested braces, as an `if` inside it). */
function namedLocation(body: string, name: string): string | undefined {
  const at = body.indexOf(`location ${name} {`);
  if (at < 0) return undefined;
  let depth = 0;
  for (let i = body.indexOf("{", at); i < body.length; i++) {
    if (body[i] === "{") depth++;
    if (body[i] === "}" && --depth === 0) return body.slice(body.indexOf("{", at) + 1, i);
  }
  return undefined;
}

it("every server answers headers over the limit (nginx's 494) through a named location that serves the path asked", () => {
  expect(servers.length).toBe(2);
  for (const { file, body } of servers) {
    const name = /^\s*error_page\s+494\s+=\s*(@\w+);/m.exec(body)?.[1];
    expect(name, file).toBeDefined();
    // The path asked goes through the server's locations again, each with its own headers.
    expect(namedLocation(body, name!), file).toMatch(/^\s*rewrite\s+\^\s+\$uri\s+last;\s*$/m);
  }
});

it("no server sends a 494 straight to a URI: not `$uri`, nor one page for every path", () => {
  for (const { file, body } of servers) {
    expect(body, file).not.toMatch(/error_page\s+[^;]*\b494\b[^;]*\$uri/);
    expect(body, file).not.toMatch(/error_page\s+[^;]*\b494\b[^;]*=\d*\s*\//);
  }
});

it("the app's named location sends a visit over http:// to https:// as the server does", () => {
  const app = servers.find((server) => server.file === "nginx.conf")!.body;
  const name = /^\s*error_page\s+494\s+=\s*(@\w+);/m.exec(app)![1];
  expect(namedLocation(app, name)).toMatch(/if\s+\(\$ghostly_plain_http\)\s*\{\s*return\s+301\s+https:\/\/\$host\$request_uri;/);
});
