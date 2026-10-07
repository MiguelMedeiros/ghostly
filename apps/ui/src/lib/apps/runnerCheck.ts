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

/**
 * Whether a policy sandboxes the runner as the WISP asks: scripts only, an opaque origin, no frames, and no network,
 * or (`internet`, the network runner) HTTPS and WSS only, for fetches, images, media and fonts.
 */
export function isRunnerPolicy(policy: string, internet = false): boolean {
  const d = directives(policy);
  const only = (name: string, ...sources: string[]) => {
    const got = d.get(name);
    return !!got && got.length === sources.length && sources.every((s) => got.includes(s));
  };
  const network = internet
    ? only("connect-src", "https:", "wss:") && only("img-src", "data:", "blob:", "https:") && only("media-src", "data:", "blob:", "https:") && only("font-src", "data:", "https:")
    : only("connect-src", "'none'");
  return network && only("sandbox", "allow-scripts") && only("default-src", "'none'") && only("frame-src", "'none'")
    && only("worker-src", "'none'") && only("form-action", "'none'") && only("frame-ancestors", "'self'")
    && only("script-src", "'unsafe-inline'", "'wasm-unsafe-eval'");
}

const checked = new Map<string, Promise<boolean | null>>();

/**
 * Whether the runner at `url` comes with its policy as a header (`internet`: the network runner's), or null when the
 * page could not be asked (offline, a dropped request). An answer is kept for the page's life; null is not, so the next
 * ask goes out again.
 */
export function runnerPolicy(url: string, fetcher: typeof fetch = fetch, internet = false): Promise<boolean | null> {
  const key = `${internet ? "net" : "plain"} ${url}`;
  let answer = checked.get(key);
  if (!answer) {
    const asking: Promise<boolean | null> = fetcher(url, { cache: "no-store", credentials: "omit", redirect: "error" })
      .then((response) => response.ok && isRunnerPolicy(response.headers.get("content-security-policy") ?? "", internet), () => {
        if (checked.get(key) === asking) checked.delete(key);
        return null;
      });
    answer = asking;
    checked.set(key, answer);
  }
  return answer;
}

/** Whether the runner at `url` comes with its policy as a header: false when it does not, or could not be asked now. */
export async function runnerAvailable(url: string, fetcher: typeof fetch = fetch, internet = false): Promise<boolean> {
  return (await runnerPolicy(url, fetcher, internet)) === true;
}

/** For tests: ask again. */
export function forgetRunnerCheck(): void {
  checked.clear();
}
