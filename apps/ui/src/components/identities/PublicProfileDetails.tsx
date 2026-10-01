import type { PublicProfileView } from "@ghostly/browser/shared/types";
import { ago } from "./contactBadges";
import { useI18n } from "../../contexts/I18nContext";
import { hostList, profileCounts } from "./profileWords";
import "./public-profile.css";

/** Who is asked for each network's profiles, before an answer names the hosts that answered. */
const ASKED: Record<string, { network: string; host?: string }> = {
  nostr: { network: "Nostr" },
  pubky: { network: "Pubky", host: "nexus.pubky.app" },
  atproto: { network: "Bluesky", host: "public.api.bsky.app" },
};


/**
 * An identity's public profile, under its card (the Identities page's details) or on its back (a contact's card, the
 * chat's picker): name and handle, a short bio, followers and following where the network counts them, and where it
 * was loaded from, since asking tells that host this device's IP address. What the account says about itself is not
 * part of the proof, and says so. `tone`: "back" on a card's dark back, "panel" on the page. `compact` leaves the bio out.
 */
export function PublicProfileDetails({ provider, profile, tone = "back", compact, testId = "public-profile" }: {
  provider: string; profile?: PublicProfileView; tone?: "back" | "panel"; compact?: boolean; testId?: string;
}) {
  const { t, language } = useI18n();
  const asked = ASKED[provider];
  if (!asked || !profile) return null;
  const now = Date.now() / 1000;
  const read = profile.fetchedAt > 0;
  const counts = profileCounts(profile, t);
  const from = read && profile.hosts.length ? hostList(profile.hosts, t) : asked.host ?? t("identities.profile.nostrRelays");
  const state = profile.loading && !read ? "loading" : profile.found ? "found" : profile.error && !read ? "failed" : "none";
  return (
    <div className="public-profile" data-tone={tone} data-testid={testId} data-state={state}>
      {state === "loading" && <p className="public-profile-note">{t("identities.profile.loading", { from })}</p>}
      {state === "failed" && <p className="public-profile-note" data-testid={`${testId}-error`}>{t("identities.profile.failed", { from })}</p>}
      {state === "none" && <p className="public-profile-note" data-testid={`${testId}-none`}>{t("identities.profile.none", { network: asked.network })}</p>}
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
        {!profile.avatar && profile.avatarMiss && <p className="public-profile-note" data-testid={`${testId}-picture-miss`}>{t("identities.profile.pictureMiss", { reason: profile.avatarMiss })}</p>}
      </>}
      {read && <p className="public-profile-source" data-testid={`${testId}-source`}>
        {state === "found" ? t("identities.profile.sourceFound", { from, time: ago(profile.fetchedAt, now, language) }) : t("identities.profile.sourceAsked", { from, time: ago(profile.fetchedAt, now, language) })}
      </p>}
    </div>
  );
}
