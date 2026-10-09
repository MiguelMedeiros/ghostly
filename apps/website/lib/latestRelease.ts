import { VERSION, assetNames } from "./release";

const LATEST = "https://api.github.com/repos/MiguelMedeiros/ghostly/releases/latest";

/** How long an answer stands: an hour, and a few minutes when GitHub did not answer (a limit, an error, no reply). */
export const ASK_EVERY_MS = 60 * 60 * 1000;
export const RETRY_AFTER_MS = 5 * 60 * 1000;

let known: { version: string; until: number } | undefined;
let asking: Promise<string> | undefined;

/**
 * The version of the newest published release, so the download panel follows
 * a release the moment it is published, without a site rebuild. GitHub's
 * "latest" is never a draft or a prerelease, and a release counts only when
 * every installer the panel links to is attached: until then, and whenever
 * GitHub cannot be reached, the panel keeps `VERSION`, whose files exist.
 * Asked on the server at most once an hour (every few minutes while GitHub does
 * not answer), one ask at a time; readers never call GitHub. Next's data cache
 * keeps only a 200, so without this a rate limit or a timeout sent every visit
 * to GitHub and made it wait: the last answer stands while the next is asked.
 */
export async function latestRelease(): Promise<string> {
  if (known && Date.now() < known.until) return known.version;
  asking ??= askGitHub()
    .then(({ version, answered }) => {
      known = { version, until: Date.now() + (answered ? ASK_EVERY_MS : RETRY_AFTER_MS) };
      return version;
    })
    .finally(() => {
      asking = undefined;
    });
  return known?.version ?? asking;
}

async function askGitHub(): Promise<{ version: string; answered: boolean }> {
  try {
    const res = await fetch(LATEST, {
      headers: { Accept: "application/vnd.github+json" },
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { version: VERSION, answered: false };
    const release = (await res.json()) as { tag_name?: string; draft?: boolean; prerelease?: boolean; assets?: { name: string }[] };
    const version = /^v(\d+\.\d+\.\d+)$/.exec(release.tag_name ?? "")?.[1];
    if (!version || release.draft || release.prerelease) return { version: VERSION, answered: true };
    const attached = new Set((release.assets ?? []).map((a) => a.name));
    return { version: Object.values(assetNames(version)).every((name) => attached.has(name)) ? version : VERSION, answered: true };
  } catch {
    return { version: VERSION, answered: false };
  }
}
