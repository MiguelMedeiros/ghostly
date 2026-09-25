import { VERSION, assetNames } from "./release";

const LATEST = "https://api.github.com/repos/MiguelMedeiros/ghostly/releases/latest";

/**
 * The version of the newest published release, so the download panel follows
 * a release the moment it is published, without a site rebuild. GitHub's
 * "latest" is never a draft or a prerelease, and a release counts only when
 * every installer the panel links to is attached: until then, and whenever
 * GitHub cannot be reached, the panel keeps `VERSION`, whose files exist.
 * Asked on the server at most once an hour; readers never call GitHub.
 */
export async function latestRelease(): Promise<string> {
  try {
    const res = await fetch(LATEST, {
      headers: { Accept: "application/vnd.github+json" },
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return VERSION;
    const release = (await res.json()) as { tag_name?: string; draft?: boolean; prerelease?: boolean; assets?: { name: string }[] };
    const version = /^v(\d+\.\d+\.\d+)$/.exec(release.tag_name ?? "")?.[1];
    if (!version || release.draft || release.prerelease) return VERSION;
    const attached = new Set((release.assets ?? []).map((a) => a.name));
    return Object.values(assetNames(version)).every((name) => attached.has(name)) ? version : VERSION;
  } catch {
    return VERSION;
  }
}
