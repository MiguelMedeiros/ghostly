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
  // `allow-pointer-lock` came later (2026-10-13): a server still sending the policy without it runs apps, without mouse look.
  const sandbox = only("sandbox", "allow-scripts", "allow-pointer-lock") || only("sandbox", "allow-scripts");
  return network && sandbox && only("default-src", "'none'") && only("frame-src", "'none'")
    && only("worker-src", "'none'") && only("form-action", "'none'") && only("frame-ancestors", "'self'")
    && only("script-src", "'unsafe-inline'", "'wasm-unsafe-eval'");
}

/**
 * What asking the runner page found: whether it sends its policy; the status of a server that did not answer for it
 * (a number); or null when it could not be asked at all (offline, a dropped request).
 */
export type RunnerAnswer = boolean | number | null;

const checked = new Map<string, Promise<RunnerAnswer>>();

/** A response that is no answer of the runner page's: the server failing (a proxy's 502 while it restarts), too busy, or timing out. */
const notAnswered = (status: number) => status >= 500 || status === 408 || status === 429;

/**
 * Whether the runner at `url` comes with its policy as a header (`internet`: the network runner's), the status when
 * its server answered with an error of its own (5xx, 408, 429), or null when the page could not be asked (offline, a
 * dropped request). An answer is kept for the page's life; a status or null is not, so the next ask goes out again.
 */
export function runnerPolicy(url: string, fetcher: typeof fetch = fetch, internet = false): Promise<RunnerAnswer> {
  const key = `${internet ? "net" : "plain"} ${url}`;
  let answer = checked.get(key);
  if (!answer) {
    const unasked = (status: number | null = null) => {
      if (checked.get(key) === asking) checked.delete(key);
      return status;
    };
    // `no-cache`, not `no-store`: the server is asked every time, but an unchanged page answers 304 with its headers
    // instead of its whole body (9.6 KiB gzip at every start, most of what a warm start downloaded).
    const asking: Promise<RunnerAnswer> = fetcher(url, { cache: "no-cache", credentials: "omit", redirect: "error" })
      .then((response) => notAnswered(response.status) ? unasked(response.status) : response.ok && isRunnerPolicy(response.headers.get("content-security-policy") ?? "", internet), () => unasked());
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
