import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  contactDay, createChatInvite, createIdentity, createRelayPayload, knockSlotIdentity, knockSlotOf, knockSlotRecords, makeStamp, readContactLink,
  requestRecords, REQUEST_LIFETIME_MS, STAMP_BITS_DEFAULT, type GhostRecord, type Identity,
} from "@ghostly/core";
import { error, ghostly, home, localRelay, ok } from "./support/cli";
// covers: headless.cli

/**
 * A contact link from the command line (WISP 8xx): made, shown, its requests listed, one accepted (the chat starts
 * with the requester's name and text), one declined, and the link turned off. The requester is this test, writing its
 * request and its knock on a Pkarr relay in this process as an app would.
 */
describe("ghostly contact-link and requests", { timeout: 120_000 }, () => {
  const dir = home("contact-link");
  let relay: { url: string; server: Server };
  const run = (...args: string[]) => ghostly(["--home", dir, ...args], { env: { GHOSTLY_PKARR_RELAYS: relay.url } });
  const put = async (identity: Identity, records: GhostRecord[]) => {
    const response = await fetch(`${relay.url}/${identity.pubKeyZ32}`, { method: "PUT", body: Buffer.from(createRelayPayload(identity, records)) });
    expect(response.status).toBe(204);
  };
  /** A requester asks through the link: its request under its own key, its knock in its slot (alone there). */
  const ask = async (link: string, name: string, text: string) => {
    const asker = createIdentity(), now = Date.now(), day = contactDay(now);
    await put(asker, requestRecords(asker.seedB64, link, { invite: createChatInvite().inviteCode, name, text, issued: now, expires: now + REQUEST_LIFETIME_MS }));
    await put(knockSlotIdentity(link, knockSlotOf(link, asker.pubKeyZ32)), knockSlotRecords(link, [{ key: asker.pubKeyZ32, day, stamp: makeStamp(link, asker.pubKeyZ32, day, STAMP_BITS_DEFAULT) }]));
    return asker.pubKeyZ32;
  };

  beforeAll(async () => {
    relay = await localRelay();
    ok(await run("profile", "create", "owner", "--use"));
  });
  afterAll(() => { relay.server.closeAllConnections(); relay.server.close(); });

  it("makes a link that names nobody, takes a request, accepts one and declines another, and turns off", async () => {
    expect(ok(await run("contact-link", "show"))).toEqual({ contactLink: null });
    expect(error(await run("requests", "list"), "not_found", 3).message).toMatch(/contact-link create/);
    const made = ok(await run("contact-link", "create")).contactLink as { code: string; link: string; state: string; waiting: number };
    expect(made).toMatchObject({ state: "open", waiting: 0, link: `https://ghostly.tools/#${made.code}` });
    const read = readContactLink(made.code);
    if (!read.ok) throw new Error(read.reason);
    expect((ok(await run("contact-link", "show")).contactLink as { code: string }).code).toBe(made.code);

    const kevin = await ask(read.linkKeyZ32, "Kevin", "Hi! I found you on your site.");
    const listed = ok(await run("requests", "list"));
    expect(listed).toMatchObject({ missed: 0, state: "open", requests: [{ id: kevin, name: "Kevin", text: "Hi! I found you on your site." }] });

    const accepted = ok(await run("requests", "accept", kevin.slice(0, 8)));
    expect(accepted).toMatchObject({ accepted: kevin });
    const chats = ok(await run("chat", "list")).chats as { id: string; label?: string }[];
    expect(chats.find((c) => c.id === accepted.chat)?.label).toBe("Kevin");
    const history = ok(await run("chat", "history", accepted.chat as string)).messages as { text: string; from: string }[];
    expect(history.map((m) => [m.from, m.text])).toEqual([["peer", "Hi! I found you on your site."]]);

    const other = await ask(read.linkKeyZ32, "Mallory", "Let me in");
    expect((ok(await run("requests", "list")).requests as { id: string }[]).map((r) => r.id)).toEqual([other]);
    expect(ok(await run("requests", "decline", other))).toEqual({ declined: other });
    expect(ok(await run("requests", "list")).requests).toEqual([]);
    expect(error(await run("requests", "accept", other), "not_found", 3).message).toMatch(/requests list/);

    expect(ok(await run("contact-link", "off"))).toEqual({ off: true });
    expect(ok(await run("contact-link", "show"))).toEqual({ contactLink: null });
    expect(error(await run("contact-link", "off"), "not_found", 3).message).toMatch(/no contact link/);
  });
});
