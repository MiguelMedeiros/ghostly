import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PublicGraphView, PublicPostsView, PublicProfileView } from "@ghostly/browser/shared/types";
import { IdentityActivity } from "../../components/identities/IdentityActivity";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { saveSession } from "../../lib/storage";

// covers: proofs.public-activity, proofs.public-activity.graph, proofs.public-profile.setting

const KEY = "y".repeat(52);
const now = () => Math.floor(Date.now() / 1000);
const profile = (patch: Partial<PublicProfileView> = {}): PublicProfileView => ({
  found: true, name: "Pat", handle: "@pat", about: "Builds things", website: "https://pat.example/blog", followers: 1204, following: 87,
  hosts: ["nexus.pubky.app"], fetchedAt: now() - 60, ...patch,
});
const posts = (patch: Partial<PublicPostsView> = {}): PublicPostsView => ({
  posts: [
    { id: "p1", createdAt: now() - 7200, text: "Hello **world** https://example.com/x", url: `https://pubky.app/post/${KEY}/p1`, images: [{ host: "nexus.pubky.app", alt: "a cat" }] },
    { id: "p2", createdAt: now() - 86400, text: "<img src=x onerror=alert(1)>", reply: true, images: [] },
  ],
  more: true, hosts: ["nexus.pubky.app"], fetchedAt: now(), profileUrl: `https://pubky.app/profile/${KEY}`, ...patch,
});
const graph = (patch: Partial<PublicGraphView> = {}): PublicGraphView => ({
  compared: true, followsYou: true, youFollow: false, contacts: [{ linkId: "L-carol", follows: true, followedBy: true }], hosts: ["nexus.pubky.app"], fetchedAt: now(), ...patch,
});
const links = [linkView({ id: "L-carol", peerPubKeyZ32: "carolkey" })];

function show(options: { posts?: PublicPostsView | null | Error; graph?: PublicGraphView | null; profile?: PublicProfileView } = {}) {
  const shown = renderApp(<IdentityActivity provider="pubky" subject={KEY} profile={options.profile ?? profile()} links={links} />);
  shown.engine.on("loadPublicPosts", () => { const p = options.posts === undefined ? posts() : options.posts; if (p instanceof Error) throw p; return p; });
  shown.engine.on("loadPublicGraph", () => (options.graph === undefined ? graph() : options.graph));
  return shown;
}

describe("a contact's identity: profile, people you know, posts", () => {
  it("asks once for posts and follows of exactly this identity, and shows them", async () => {
    const { engine } = show();
    saveSession({ id: "s-carol", mySeedB64: "seed", peerPubKeyB64: "carolkey", encKeyB64: "enc", messages: [], createdAt: 0, label: "Carol" });
    await screen.findByTestId("contact-activity-posts");
    expect(engine.callsTo("loadPublicPosts")).toEqual([{ provider: "pubky", subject: KEY, force: false }]);
    expect(engine.callsTo("loadPublicGraph")).toEqual([{ provider: "pubky", subject: KEY, force: false }]);
    expect(screen.getByTestId("contact-activity-name")).toHaveTextContent("Pat");
    expect(screen.getByTestId("contact-activity-counts")).toHaveTextContent("1,204 followers · 87 following");
    expect(screen.getByTestId("contact-activity-website")).toHaveAttribute("href", "https://pat.example/blog");
    expect(screen.getByTestId("contact-activity-website")).toHaveAttribute("rel", "noopener noreferrer nofollow");
    expect(screen.getByTestId("contact-activity-open-profile")).toHaveAttribute("href", `https://pubky.app/profile/${KEY}`);
    expect(screen.getByTestId("contact-activity-follows-you")).toBeInTheDocument();
    expect(screen.queryByTestId("contact-activity-you-follow")).toBeNull();
    const chip = screen.getByTestId("contact-activity-contact");
    expect(chip).toHaveTextContent("Carol");
    expect(chip).toHaveAttribute("aria-label", "Follows Carol, and Carol follows them");
    const [first, second] = screen.getAllByTestId("contact-activity-post");
    expect(within(first).getByTestId("contact-activity-post-time")).toHaveTextContent(/2 h|2 hours/);
    expect(within(first).getByTestId("contact-activity-post-open")).toHaveAttribute("href", `https://pubky.app/post/${KEY}/p1`);
    expect(first.querySelector("strong")).toHaveTextContent("world");
    // Markup in a post is text, never an element.
    expect(second.querySelector("img")).toBeNull();
    expect(within(second).getByTestId("contact-activity-post-text")).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(second).toHaveTextContent("Reply");
    expect(screen.getByTestId("contact-activity-source")).toHaveTextContent("Loaded from nexus.pubky.app");
  });

  it("pictures load only on a tap, from the post kept by the engine", async () => {
    const { engine, user } = show();
    engine.on("loadPublicPostImage", () => ({ src: "data:image/jpeg;base64,/9j/2Q==", hosts: ["nexus.pubky.app"], width: 64, height: 48 }));
    const button = await screen.findByTestId("contact-activity-post-image");
    expect(button).toHaveTextContent("nexus.pubky.app");
    expect(engine.callsTo("loadPublicPostImage")).toEqual([]);
    expect(document.querySelector("img[src^='https:']")).toBeNull();
    await user.click(button);
    const picture = await screen.findByTestId("contact-activity-post-picture");
    expect(picture).toHaveAttribute("alt", "a cat");
    expect(engine.callsTo("loadPublicPostImage")).toEqual([{ provider: "pubky", subject: KEY, postId: "p1", index: 0 }]);
  });

  it("a refused picture says why", async () => {
    const { engine, user } = show();
    engine.on("loadPublicPostImage", () => ({ miss: "it is a GIF", hosts: [] }));
    await user.click(await screen.findByTestId("contact-activity-post-image"));
    expect(await screen.findByTestId("contact-activity-post-image-error")).toHaveTextContent("Not shown: it is a GIF.");
  });

  it("more posts on demand", async () => {
    const { engine, user } = show();
    await user.click(await screen.findByTestId("contact-activity-more"));
    await act(async () => {});
    expect(engine.callsTo("loadPublicPosts")).toContainEqual({ provider: "pubky", subject: KEY, more: true });
  });

  it("loading, empty and error states; Try again asks again", async () => {
    let release!: (v: PublicPostsView) => void;
    const { engine, user } = renderApp(<IdentityActivity provider="pubky" subject={KEY} profile={profile()} links={links} />);
    engine.on("loadPublicGraph", () => graph({ compared: false, followsYou: false, contacts: [] }));
    engine.on("loadPublicPosts", () => new Promise<PublicPostsView>(r => { release = r; }));
    expect(await screen.findByTestId("contact-activity-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("contact-activity-chips")).toBeNull();
    await act(async () => release(posts({ posts: [], more: false })));
    expect(await screen.findByTestId("contact-activity-empty")).toHaveTextContent("No posts yet.");
    engine.on("loadPublicPosts", () => { throw new Error("The Pubky index answered 503"); });
    screen.getByTestId("contact-activity");
    const again = renderApp(<IdentityActivity provider="pubky" subject={"z".repeat(52)} links={links} />);
    expect(await within(again.container).findByTestId("contact-activity-error")).toHaveTextContent("503");
    engine.on("loadPublicPosts", () => posts());
    await user.click(within(again.container).getByTestId("contact-activity-retry"));
    await within(again.container).findByTestId("contact-activity-posts");
    expect(engine.callsTo("loadPublicPosts").slice(-1)[0]).toEqual({ provider: "pubky", subject: "z".repeat(52), force: true });
  });

  it("with Load public profiles off, nothing is asked", async () => {
    const { engine } = renderApp(<IdentityActivity provider="pubky" subject={KEY} profile={profile()} links={links} />);
    act(() => engine.update({ settings: { ...engine.state.settings, publicProfiles: false } }));
    expect(await screen.findByTestId("contact-activity-off")).toBeInTheDocument();
    await act(async () => {});
    // The first render may have asked before the state arrived; after it, nothing more.
    const asked = engine.callsTo("loadPublicPosts").length;
    await act(async () => {});
    expect(engine.callsTo("loadPublicPosts").length).toBe(asked);
    expect(screen.queryByTestId("contact-activity-posts")).toBeNull();
  });

  it("a network without posts shows nothing", () => {
    const { container } = renderApp(<IdentityActivity provider="domain" subject="example.com" links={links} />);
    expect(container.querySelector("[data-testid=contact-activity]")).toBeNull();
  });
});
