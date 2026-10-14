import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** The entries under each `ports:` of a compose file (read as text: no YAML parser here). */
function ports(file: string): string[] {
  const lines = readFileSync(resolve(import.meta.dirname, "../../..", file), "utf8").split("\n");
  const found: string[] = [];
  lines.forEach((line, start) => {
    if (!/^\s+ports:\s*$/.test(line)) return;
    for (const next of lines.slice(start + 1)) {
      const entry = /^\s+- "?([^"#]+)"?\s*$/.exec(next);
      if (entry) found.push(entry[1].trim());
      else if (!/^\s*(#.*)?$/.test(next)) break;
    }
  });
  return found;
}

/** Compose's `${NAME}` and `${NAME:-default}` (a default may hold another one), with the given environment. */
function interpolate(text: string, env: Record<string, string>): string {
  let out = text;
  for (let before = ""; before !== out;) {
    before = out;
    out = out.replace(/\$\{([A-Z0-9_]+)(?::-([^${}]*))?\}/g, (_, name: string, fallback?: string) => env[name] || fallback || "");
  }
  return out;
}

/** The host address a `[address:]published:target` entry binds; none means every interface. */
function hostAddress(entry: string): string | undefined {
  const parts = entry.split(":");
  return parts.length > 2 ? parts.slice(0, -2).join(":") : undefined;
}

describe("the ports the compose files publish", () => {
  it.each(["apps/website/docker-compose.yml", "infra/docker-compose.yml"])("%s answers on this machine only by default", (file) => {
    const entries = ports(file);
    expect(entries.length, "a published port").toBeGreaterThan(0);
    for (const entry of entries) expect(hostAddress(interpolate(entry, {})), entry).toBe("127.0.0.1");
  });

  it("the website's port moves with WEBSITE_PORT and stays local; WEBSITE_BIND names another address", () => {
    const [entry] = ports("apps/website/docker-compose.yml");
    expect(interpolate(entry, {})).toBe("127.0.0.1:3000:3000");
    expect(interpolate(entry, { WEBSITE_PORT: "3144" })).toBe("127.0.0.1:3144:3000");
    expect(interpolate(entry, { WEBSITE_BIND: "172.17.0.1:3144" })).toBe("172.17.0.1:3144:3000");
    expect(interpolate(entry, { WEBSITE_BIND: "0.0.0.0:8088", WEBSITE_PORT: "3144" })).toBe("0.0.0.0:8088:3000");
  });
});
