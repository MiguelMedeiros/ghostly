/**
 * Whether this server sends the mini-app runner's policy (WISP 1200, "Per client"). A self-hosted server whose runner
 * location lacks it would frame apps without their sandbox: the runner refuses to start there, and the client hides
 * Apps. Asked once, of the runner page itself, never of anyone else.
 */

/** `directive -> sources`, the first of each name, as a browser reads a policy. */
function directives(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), sources);
  }
  return out;
}

/** Whether a policy sandboxes the runner as the WISP asks: scripts only, an opaque origin, no network, no frames. */
export function isRunnerPolicy(policy: string): boolean {
  const d = directives(policy);
  const only = (name: string, ...sources: string[]) => {
    const got = d.get(name);
    return !!got && got.length === sources.length && sources.every((s) => got.includes(s));
  };
  return only("sandbox", "allow-scripts") && only("default-src", "'none'") && only("connect-src", "'none'") && only("frame-src", "'none'")
    && only("worker-src", "'none'") && only("form-action", "'none'") && only("frame-ancestors", "'self'");
}

let checked: Promise<boolean> | null = null;

/** Whether the runner at `url` comes with its policy as a header. Asked once per page; false when it cannot be read. */
export function runnerAvailable(url: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  checked ??= fetcher(url, { cache: "no-store", credentials: "omit", redirect: "error" })
    .then((response) => response.ok && isRunnerPolicy(response.headers.get("content-security-policy") ?? ""))
    .catch(() => false);
  return checked;
}

/** For tests: ask again. */
export function forgetRunnerCheck(): void {
  checked = null;
}
