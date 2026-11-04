import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IdentityFetch, IdentityFetchResponse } from "../src/proofs/contract";
import { PublicActivity } from "../src/engine/publicActivity";
import { PublicProfiles, type ProfileSubject } from "../src/engine/publicProfiles";
import { testAtprotoNetwork } from "./helpers/atprotoNetwork";
// covers: proofs.public-profile.picture, proofs.public-activity

vi.setConfig({ testTimeout: 20_000 });

/** A 1×1 PNG header: enough for the dimension check; decoding is stubbed. */
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);
const CID = "bafkreihwihm6kpd6zuwhhlro75p5qks5qtrcu55jp3gddbfjsieiv7wuka";

beforeEach(() => {
  vi.stubGlobal("createImageBitmap", async () => ({ close() {} }));
  vi.stubGlobal("OffscreenCanvas", class { getContext() { return { drawImage() {} }; } async convertToBlob() { return new Blob([new Uint8Array([255, 216, 255, 217])], { type: "image/jpeg" }); } });
});
afterEach(() => vi.unstubAllGlobals());

const reply = (status: number, body: unknown, contentType = "application/json"): IdentityFetchResponse => {
  const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(JSON.stringify(body));
  return { status, contentType, text: new TextDecoder().decode(bytes), bytes };
};

/**
 * A contact's Bluesky identity whose account lives on contact.example (its picture and its posts' pictures are blobs
 * there), and the person's own identity on own.example; Bluesky's AppView answers for both.
 */
function world() {
  const net = testAtprotoNetwork();
  const contact = net.account("contact", { pds: "https://contact.example" });
  const own = net.account("me", { pds: "https://own.example" });
  const fetch: IdentityFetch = async (url, init) => {
    const u = new URL(url);
    if (u.origin === "https://public.api.bsky.app") {
      net.asked.push(url);
      const did = u.searchParams.get("actor")!;
      if (u.pathname === "/xrpc/app.bsky.actor.getProfile") return reply(200, { did, displayName: "Someone", avatar: `https://cdn.bsky.app/img/avatar/plain/${did}/${CID}@jpeg` });
      if (u.pathname === "/xrpc/app.bsky.feed.getAuthorFeed") return reply(200, { feed: [{ post: {
        uri: `at://${did}/app.bsky.feed.post/3k`, author: { did },
        record: { text: "a picture", createdAt: "2026-10-01T00:00:00Z", embed: { $type: "app.bsky.embed.images", images: [{ alt: "", image: { ref: { $link: CID }, mimeType: "image/png" } }] } },
      } }] });
    }
    if (u.pathname === "/xrpc/com.atproto.sync.getBlob") { net.asked.push(url); return reply(200, PNG, "image/png"); }
    return net.fetch(url, init);
  };
  const settings = { relayOnly: false };
  const subjects: ProfileSubject[] = [{ provider: "atproto", subject: contact.did }, { provider: "atproto", subject: own.did }];
  const ownSubjects = () => [subjects[1]];
  const common = {
    enabled: () => true, online: () => true, eligible: () => subjects, nostrRelays: () => [], fetch,
    relayOnly: () => settings.relayOnly, own: ownSubjects,
  };
  const profiles = new PublicProfiles({ ...common, emit: () => {} });
  const activity = new PublicActivity({ ...common, contacts: () => [{ ...subjects[0], linkId: "L" }] });
  const askedHosts = () => net.asked.map(u => new URL(u).host);
  return { net, contact, own, settings, profiles, activity, askedHosts, subjects };
}

describe("Hide my IP from contacts: a contact's public profile, posts and pictures", () => {
  it("off: the contact's picture is read from the server they chose", async () => {
    const w = world();
    await w.profiles.load(); await w.profiles.clear();
    await w.profiles.request(w.subjects[0]);
    expect(w.askedHosts()).toContain("contact.example");
    expect(w.profiles.view(w.subjects[0])?.avatar).toMatch(/^data:image\/jpeg/);
  });

  it("on: the contact's server is never contacted; the rest of the profile shows and the picture says why it is missing", async () => {
    const w = world();
    w.settings.relayOnly = true;
    await w.profiles.load(); await w.profiles.clear();
    await w.profiles.request(w.subjects[0]);
    expect(w.askedHosts()).toContain("public.api.bsky.app");
    expect(w.askedHosts()).not.toContain("contact.example");
    const view = w.profiles.view(w.subjects[0]);
    expect(view).toMatchObject({ found: true, name: "Someone" });
    expect(view?.avatar).toBeUndefined();
    expect(view?.avatarMiss).toMatch(/Hide my IP from contacts is on/);
  });

  it("on: the person's own identity still reads its picture from its own server", async () => {
    const w = world();
    w.settings.relayOnly = true;
    await w.profiles.load(); await w.profiles.clear();
    await w.profiles.request(w.subjects[1]);
    expect(w.askedHosts()).toContain("own.example");
    expect(w.profiles.view(w.subjects[1])?.avatar).toMatch(/^data:image\/jpeg/);
  });

  it("a post's picture: read from the contact's server with the setting off, never with it on", async () => {
    const off = world();
    const posts = await off.activity.loadPosts(off.subjects[0]);
    const image = await off.activity.loadImage({ ...off.subjects[0], postId: posts!.posts[0].id, index: 0 });
    expect(image.src).toMatch(/^data:image\/jpeg/);
    expect(off.askedHosts()).toContain("contact.example");

    const on = world();
    on.settings.relayOnly = true;
    const shown = await on.activity.loadPosts(on.subjects[0]);
    expect(shown?.posts).toHaveLength(1);
    const refused = await on.activity.loadImage({ ...on.subjects[0], postId: shown!.posts[0].id, index: 0 });
    expect(refused.src).toBeUndefined();
    expect(refused.miss).toMatch(/Hide my IP from contacts is on/);
    expect(on.askedHosts()).not.toContain("contact.example");
  });
});
