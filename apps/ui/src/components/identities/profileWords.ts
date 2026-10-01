import type { PublicProfileView } from "@ghostly/browser/shared/types";
import type { Translate } from "../../contexts/I18nContext";
import { formatAmount } from "../../lib/amount";

/** "1,204 followers · 87 following", or nothing when the network gave no counts. */
export function profileCounts(p: Pick<PublicProfileView, "followers" | "following">, t: Translate): string {
  const followers = p.followers === undefined ? "" : p.followers === 1 ? t("identities.profile.followerOne") : t("identities.profile.followers", { count: formatAmount(p.followers, t.language) });
  const following = p.following === undefined ? "" : t("identities.profile.following", { count: formatAmount(p.following, t.language) });
  return [followers, following].filter(Boolean).join(" · ");
}

/** "nexus.pubky.app", "relay.damus.io and nos.lol". */
export const hostList = (hosts: string[], t: Translate) =>
  (hosts.length <= 1 ? hosts.join("") : t("identities.profile.and", { list: hosts.slice(0, -1).join(", "), last: hosts[hosts.length - 1] }));
