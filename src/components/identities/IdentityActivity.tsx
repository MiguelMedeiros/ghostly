import { useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { LinkView, PublicPostImageView, PublicPostView, PublicProfileView } from "@ghostly/browser/shared/types";
import { usePublicActivity } from "../../hooks/usePublicActivity";
import { useLoadPublicProfiles } from "../../hooks/usePublicProfileRequest";
import { externalLinkProps } from "../../lib/externalLink";
import { shownUrl } from "../../lib/parse";
import { contactTag } from "../../lib/publicKeyLabel";
import { listSessions } from "../../lib/storage";
import { RichText } from "../rich/RichText";
import { ACTIVITY_NETWORKS } from "./activityNetworks";
import { ago } from "./contactBadges";
import "./identity-activity.css";


const number = (n: number) => n.toLocaleString();
const hostList = (hosts: string[]) => (hosts.length <= 1 ? hosts.join("") : `${hosts.slice(0, -1).join(", ")} and ${hosts[hosts.length - 1]}`);
const fullDate = (seconds: number) => new Date(seconds * 1000).toLocaleString();

/** A contact's name for a chip: the chat's name here, what they call themselves, or their key's tag. */
function contactName(linkId: string, links: readonly LinkView[]): string {
  const peer = links.find(l => l.id === linkId)?.peerPubKeyZ32;
  const session = peer ? listSessions().find(s => s.peerPubKeyB64 === peer) : undefined;
  return session?.label || session?.nick || `Contact · ${contactTag(peer ?? linkId)}`;
}

/**
 * The chosen identity of a contact, under the deck of their cards (ContactIdentitiesPanel.tsx): its public profile, its
 * counts, who of the reader's people it follows or is followed by, and its recent posts. Asked only while it is on
 * screen, from the hosts named at the bottom; what the account says about itself, never part of the proof. Posts are
 * safe rich text (src/lib/parse, no markup), their pictures loaded on a tap.
 */
export function IdentityActivity({ provider, subject, profile, links }: { provider: string; subject: string; profile?: PublicProfileView; links: readonly LinkView[] }) {
  const on = useLoadPublicProfiles();
  const { posts, graph, loading, error, more, retry } = usePublicActivity(provider, subject, on);
  const network = Object.prototype.hasOwnProperty.call(ACTIVITY_NETWORKS, provider) ? ACTIVITY_NETWORKS[provider] : undefined;
  if (!network) return null;
  if (!on) return <p className="identity-activity-note" data-testid="contact-activity-off">Public profiles are off (Settings → Security).</p>;
  const found = profile?.found ? profile : undefined;
  const counts = found ? [found.followers !== undefined ? `${number(found.followers)} ${found.followers === 1 ? "follower" : "followers"}` : "", found.following !== undefined ? `${number(found.following)} following` : ""].filter(Boolean).join(" · ") : "";
  const hosts = [...new Set([...(found?.hosts ?? []), ...(posts?.hosts ?? []), ...(graph?.hosts ?? [])])];
  const state = loading === "posts" ? "loading" : error && !posts ? "error" : posts ? (posts.posts.length ? "posts" : "empty") : "idle";

  return (
    <section className="identity-activity" data-testid="contact-activity" data-provider={provider} data-state={state} aria-label={`${network} profile and posts`}>
      {found && <div className="identity-activity-profile" data-testid="contact-activity-profile">
        {found.avatar?.startsWith("data:image/") && <img src={found.avatar} alt="" className="identity-activity-avatar" data-testid="contact-activity-avatar" />}
        <div className="identity-activity-who">
          {found.name && <span className="identity-activity-name" data-testid="contact-activity-name">{found.name}</span>}
          {found.handle && <span className="identity-activity-handle" data-testid="contact-activity-handle"><bdi>{found.handle}</bdi></span>}
          {counts && <span className="identity-activity-counts" data-testid="contact-activity-counts">{counts}</span>}
        </div>
      </div>}
      {found?.about && <p className="identity-activity-about" data-testid="contact-activity-about">{found.about}</p>}
      {(found?.website || posts?.profileUrl) && <div className="identity-activity-links">
        {found?.website && <a {...externalLinkProps(found.website)} rel="noopener noreferrer nofollow" dir="ltr" className="identity-activity-link" data-testid="contact-activity-website"><bdi>{shownUrl(found.website)}</bdi></a>}
        {posts?.profileUrl && <a {...externalLinkProps(posts.profileUrl)} className="identity-activity-link" data-testid="contact-activity-open-profile">Open in {network}</a>}
      </div>}

      <Chips graph={graph} links={links} />

      <div className="identity-activity-posts-head">
        <h4 className="identity-activity-heading">Posts</h4>
        {state === "error" && <button type="button" className="identity-activity-button" data-testid="contact-activity-retry" onClick={retry}>Try again</button>}
      </div>
      {state === "loading" && <p className="identity-activity-note" data-testid="contact-activity-loading">Loading…</p>}
      {state === "error" && <p className="identity-activity-note" role="alert" data-testid="contact-activity-error">Could not load posts: {error}</p>}
      {state === "empty" && <p className="identity-activity-note" data-testid="contact-activity-empty">No posts yet.</p>}
      {posts && posts.posts.length > 0 && <ol className="identity-activity-posts" data-testid="contact-activity-posts">
        {posts.posts.map(p => <Post key={p.id} post={p} provider={provider} subject={subject} network={network} />)}
      </ol>}
      {posts?.hidden ? <p className="identity-activity-note" data-testid="contact-activity-hidden">{posts.hidden} hidden by your mute list.</p> : null}
      {posts?.more && <button type="button" className="identity-activity-button" data-testid="contact-activity-more" aria-disabled={loading === "more" || undefined} onClick={more}>{loading === "more" ? "Loading…" : "More posts"}</button>}
      {error && posts && <p className="identity-activity-note" role="alert" data-testid="contact-activity-error">{error}</p>}

      {hosts.length > 0 && <p className="identity-activity-source" data-testid="contact-activity-source">Loaded from {hostList(hosts)}, which saw this device’s IP address. What the account says, not part of the proof.</p>}
    </section>
  );
}

/** "Follows you", "You follow", and the reader's contacts it follows or is followed by. Only what is true is shown. */
function Chips({ graph, links }: { graph?: PublicGraphViewLike | null; links: readonly LinkView[] }) {
  if (!graph?.compared) return null;
  const any = graph.followsYou || graph.youFollow || graph.contacts.length > 0;
  if (!any) return null;
  return (
    <ul className="identity-activity-chips" data-testid="contact-activity-chips" aria-label="People you know">
      {graph.followsYou && <li className="identity-activity-chip" data-accent="" data-testid="contact-activity-follows-you">Follows you</li>}
      {graph.youFollow && <li className="identity-activity-chip" data-testid="contact-activity-you-follow">You follow</li>}
      {graph.contacts.map(c => {
        const name = contactName(c.linkId, links);
        const how = c.follows && c.followedBy ? `Follows ${name}, and ${name} follows them` : c.follows ? `Follows ${name}` : `${name} follows them`;
        return <li key={c.linkId} className="identity-activity-chip" data-testid="contact-activity-contact" data-link={c.linkId} title={how} aria-label={how}>
          <span aria-hidden="true">{c.follows && c.followedBy ? "⇄" : c.follows ? "→" : "←"}</span> <bdi>{name}</bdi>
        </li>;
      })}
    </ul>
  );
}
type PublicGraphViewLike = NonNullable<ReturnType<typeof usePublicActivity>["graph"]>;

function Post({ post, provider, subject, network }: { post: PublicPostView; provider: string; subject: string; network: string }) {
  return (
    <li className="identity-activity-post" data-testid="contact-activity-post" data-post={post.id}>
      {post.text && <RichText text={post.text} className="identity-activity-post-text" testId="contact-activity-post-text" />}
      {post.images.length > 0 && <div className="identity-activity-images">
        {post.images.map((img, i) => <PostImage key={i} index={i} image={img} postId={post.id} provider={provider} subject={subject} />)}
      </div>}
      <div className="identity-activity-post-meta">
        <time dateTime={new Date(post.createdAt * 1000).toISOString()} title={fullDate(post.createdAt)} data-testid="contact-activity-post-time">{ago(post.createdAt)}</time>
        {post.reply && <span>· Reply</span>}
        {post.url && <a {...externalLinkProps(post.url)} className="identity-activity-link" data-testid="contact-activity-post-open" aria-label={`Open this post in ${network}`}>Open</a>}
      </div>
    </li>
  );
}

/** A post's picture: a button naming the host until tapped, then the re-encoded picture (or why there is none). */
function PostImage({ image, index, postId, provider, subject }: { image: { host?: string; alt?: string }; index: number; postId: string; provider: string; subject: string }) {
  const [shown, setShown] = useState<PublicPostImageView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const from = image.host ?? "the account’s server";
  if (shown?.src) return <img src={shown.src} alt={image.alt ?? ""} width={shown.width} height={shown.height} className="identity-activity-picture" data-testid="contact-activity-post-picture" />;
  const load = () => {
    if (busy) return;
    setBusy(true); setError("");
    void engine.call("loadPublicPostImage", { provider, subject, postId, index })
      .then(v => { setShown(v); if (!v.src) setError(v.miss ? `Not shown: ${v.miss}.` : "Not shown."); }, e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <span className="identity-activity-image">
      <button type="button" className="identity-activity-image-button" data-testid="contact-activity-post-image" aria-disabled={busy || undefined} onClick={load}
        title={`Loading asks ${from}, which sees your IP address`}>
        {busy ? "Loading…" : "Show picture"}<span className="identity-activity-image-host">{from}</span>
      </button>
      {image.alt && <span className="identity-activity-image-alt">{image.alt}</span>}
      {error && <span className="identity-activity-note" role="alert" data-testid="contact-activity-post-image-error">{error}</span>}
    </span>
  );
}
