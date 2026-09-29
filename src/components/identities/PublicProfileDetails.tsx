import type { PublicProfileView } from "@ghostly/browser/shared/types";
import { ago } from "./contactBadges";
import "./public-profile.css";

/** Who is asked for each network's profiles, before an answer names the hosts that answered. */
const ASKED: Record<string, { network: string; host: string }> = {
  nostr: { network: "Nostr", host: "your Nostr relays" },
  pubky: { network: "Pubky", host: "nexus.pubky.app" },
  atproto: { network: "Bluesky", host: "public.api.bsky.app" },
};

const number = (n: number) => n.toLocaleString();
const plural = (n: number, one: string, many: string) => `${number(n)} ${n === 1 ? one : many}`;

/** "1,204 followers · 87 following", or nothing when the network gave no counts. */
function profileCounts(p: Pick<PublicProfileView, "followers" | "following">): string {
  return [p.followers !== undefined ? plural(p.followers, "follower", "followers") : "", p.following !== undefined ? `${number(p.following)} following` : ""].filter(Boolean).join(" · ");
}

/** "nexus.pubky.app", "relay.damus.io and nos.lol". */
const hostList = (hosts: string[]) => (hosts.length <= 1 ? hosts.join("") : `${hosts.slice(0, -1).join(", ")} and ${hosts[hosts.length - 1]}`);

/**
 * An identity's public profile, under its card (the Identities page's details) or on its back (a contact's card, the
 * chat's picker): name and handle, a short bio, followers and following where the network counts them, and where it
 * was loaded from, since asking tells that host this device's IP address. What the account says about itself is not
 * part of the proof, and says so. `tone`: "back" on a card's dark back, "panel" on the page. `compact` leaves the bio out.
 */
export function PublicProfileDetails({ provider, profile, tone = "back", compact, testId = "public-profile" }: {
  provider: string; profile?: PublicProfileView; tone?: "back" | "panel"; compact?: boolean; testId?: string;
}) {
  const asked = ASKED[provider];
  if (!asked || !profile) return null;
  const now = Date.now() / 1000;
  const read = profile.fetchedAt > 0;
  const counts = profileCounts(profile);
  const from = read && profile.hosts.length ? hostList(profile.hosts) : asked.host;
  const state = profile.loading && !read ? "loading" : profile.found ? "found" : profile.error && !read ? "failed" : "none";
  return (
    <div className="public-profile" data-tone={tone} data-testid={testId} data-state={state}>
      {state === "loading" && <p className="public-profile-note">Loading the public profile from {from}…</p>}
      {state === "failed" && <p className="public-profile-note" data-testid={`${testId}-error`}>The public profile could not be loaded from {from}. It is asked again later.</p>}
      {state === "none" && <p className="public-profile-note" data-testid={`${testId}-none`}>No public profile on {asked.network} for this identity.</p>}
      {state === "found" && <>
        <div className="public-profile-head">
          {profile.avatar?.startsWith("data:image/") && <img src={profile.avatar} alt="" className="public-profile-avatar" data-testid={`${testId}-avatar`} />}
          <span className="public-profile-who">
            {profile.name && <span className="public-profile-name" data-testid={`${testId}-name`}>{profile.name}</span>}
            {profile.handle && <span className="public-profile-handle" data-testid={`${testId}-handle`}>{profile.handle}</span>}
            {counts && <span className="public-profile-counts" data-testid={`${testId}-counts`}>{counts}</span>}
          </span>
        </div>
        {!compact && profile.about && <p className="public-profile-about" data-testid={`${testId}-about`}>{profile.about}</p>}
        {!profile.avatar && profile.avatarMiss && <p className="public-profile-note" data-testid={`${testId}-picture-miss`}>The profile’s picture is not shown: {profile.avatarMiss}.</p>}
      </>}
      {read && <p className="public-profile-source" data-testid={`${testId}-source`}>
        {state === "found" ? "Loaded from" : "Asked"} {from} {ago(profile.fetchedAt, now)}. {state === "found" ? "What the account says about itself, not part of the proof. " : ""}Asking told that server this device’s IP address.
      </p>}
    </div>
  );
}
