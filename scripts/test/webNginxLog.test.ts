import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

/**
 * app.ghostly.tools keeps no log of who visits. web/nginx.conf logs the time, the file and the response, never the
 * visitor's address (nor the proxy headers that carry it behind Cloudflare), browser, referrer or query string.
 */
const conf = readFileSync(join(import.meta.dirname, "../../web/nginx.conf"), "utf8")
  .split("\n")
  .map((line) => line.replace(/#.*/, ""))
  .join("\n");

/** Anything that names the visitor, where they came from, or what they typed after `?`. */
const PERSONAL = [
  "$remote_addr", "$binary_remote_addr", "$realip_remote_addr", "$remote_user", "$remote_port",
  "$http_x_forwarded_for", "$proxy_add_x_forwarded_for", "$http_x_real_ip", "$http_cf_connecting_ip", "$http_true_client_ip",
  "$http_referer", "$http_user_agent", "$http_cookie",
  "$request", "$request_uri", "$args", "$query_string", "$arg_",
];

const formats = [...conf.matchAll(/log_format\s+(\S+)\s+([^;]*);/g)].map(([, name, format]) => ({ name, format }));

it("defines its own log format, and it names no one", () => {
  expect(formats.map((f) => f.name)).toEqual(["ghostly"]);
  const variables = formats[0].format.match(/\$[a-z0-9_]+/g) ?? [];
  expect(variables.length).toBeGreaterThan(0);
  for (const v of variables) {
    for (const personal of PERSONAL) expect(v === personal || (personal.endsWith("_") && v.startsWith(personal)), `${v} in log_format`).toBe(false);
  }
});

it("every access log uses that format (the image's default one logs the address and the browser)", () => {
  const logs = [...conf.matchAll(/access_log\s+([^;]*);/g)].map(([, args]) => args.trim().split(/\s+/));
  expect(logs.length).toBeGreaterThan(0);
  for (const args of logs) expect(args[0] === "off" || args[1] === "ghostly", `access_log ${args.join(" ")}`).toBe(true);
});

it("keeps error lines, which name the client, to crit and above", () => {
  const levels = [...conf.matchAll(/error_log\s+([^;]*);/g)].map(([, args]) => args.trim().split(/\s+/)[1]);
  expect(levels.length).toBeGreaterThan(0);
  for (const level of levels) expect(["crit", "alert", "emerg"]).toContain(level);
});

it("does not trust a proxy's header as the client address", () => {
  expect(conf).not.toMatch(/\b(set_real_ip_from|real_ip_header|real_ip_recursive)\b/);
});
