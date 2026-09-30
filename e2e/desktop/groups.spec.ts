import { test, expect } from "@playwright/test";
import { desktopHome, attachDesktopLogs } from "../support/desktop";
import { LocalRelay } from "../support/relay";
import { desktopNetwork } from "../matrix/desktop";
import { desktopPerson, type DesktopPerson } from "../matrix/people";

/**
 * Two Desktop apps on Linux, whose WebView has no WebRTC, in one community: one makes it, the other joins by its link,
 * and they read each other (WISP 9xx § Transports). A group's links (the entry session, then the edge) go over Iroh or
 * HyperDHT here, told in each link's own packet (`_tr`). Before, group links were WebRTC only: New group was off on
 * Linux, and a link made elsewhere never let a Linux app in.
 *
 * Nothing leaves the machine but Iroh's relays: both apps read and publish on the test's Pkarr relay
 * (GHOSTLY_PKARR_RELAYS) and find each other on a HyperDHT testnet in this process (GHOSTLY_HYPERDHT_BOOTSTRAP).
 * Either native transport passes.
 */

const run = <T>(p: DesktopPerson, script: string, ...args: unknown[]) => p.app.execute<T>(script, ...args);
const click = (p: DesktopPerson, testId: string) => expect(async () => {
  await run(p, `const e = document.querySelector('[data-testid="' + arguments[0] + '"]'); if (!e) throw new Error("no " + arguments[0]); e.click();`, testId);
}).toPass({ timeout: 30_000 });
const attribute = (p: DesktopPerson, testId: string, name: string) =>
  run<string | null>(p, `return document.querySelector('[data-testid="' + arguments[0] + '"]')?.getAttribute(arguments[1]) ?? null;`, testId, name);
const textOf = (p: DesktopPerson, testId: string) =>
  run<string>(p, `return document.querySelector('[data-testid="' + arguments[0] + '"]')?.textContent ?? "";`, testId);

test("two Linux Desktop apps without WebRTC make a community, join it by its link, and read each other", {
  tag: ["@feature:groups.native-links", "@feature:groups.community.create", "@feature:groups.community.join", "@feature:groups.community.send"],
}, async () => {
  test.setTimeout(10 * 60_000);
  const relay = new LocalRelay();
  const network = await desktopNetwork(relay);
  const cleanup: (() => Promise<void> | void)[] = [() => relay.close(), () => network.close()];
  try {
    const open = async (name: string): Promise<DesktopPerson> => {
      const home = desktopHome(name);
      const person = await desktopPerson(name, { home: home.dir, env: network.env });
      cleanup.push(async () => { await person.stop(); attachDesktopLogs(name, home.dir); home.remove(); });
      return person;
    };
    const a = await open("ana");
    const b = await open("bia");
    for (const p of [a, b]) expect(await run<boolean>(p, `return typeof RTCPeerConnection !== "undefined";`), `${p.name} has no WebRTC`).toBe(false);

    // Ana makes a community: nothing says groups cannot connect from here.
    await click(a, "sidebar-new-more");
    await click(a, "new-group");
    await expect.poll(() => a.app.text('[data-testid="new-group-name"]'), { message: "the New group dialog" }).not.toBeNull();
    expect(await run<boolean>(a, `return !!document.querySelector('[data-testid="new-group-no-webrtc"]');`)).toBe(false);
    await a.app.type('[data-testid="new-group-name"]', "Penguins");
    await click(a, "new-group-create");
    let url = "";
    await expect.poll(async () => (url = await run<string>(a, `return document.querySelector('[data-testid="group-link-url"]')?.value ?? "";`)),
      { timeout: 30_000, message: "the group's link" }).toMatch(/#\/join\/group2\//);
    await click(a, "group-share-done");

    // Bia opens the link: Ana's app lets her in over Iroh or HyperDHT.
    await b.go(url.slice(url.indexOf("#")));
    await expect.poll(() => attribute(b, "group-chat", "data-status"), { timeout: 240_000, message: "bia is in" }).toBe("active");
    for (const p of [a, b]) {
      await expect.poll(() => textOf(p, "group-members"), { timeout: 180_000, message: `${p.name} sees 2 members` }).toContain("2 members");
      await expect.poll(() => textOf(p, "group-members"), { timeout: 180_000, message: `${p.name} reaches the other` }).toContain("1 of 1 reachable");
      await expect.poll(() => attribute(p, "group-connection-options", "data-transport"), { message: `${p.name}'s group link is native` }).toMatch(/^(iroh|hyperdht)\/1$/);
    }

    // They read each other.
    await a.say("hello from ana");
    await b.say("hello from bia");
    for (const p of [a, b]) for (const text of ["hello from ana", "hello from bia"]) {
      await expect.poll(() => p.shows(text), { timeout: 120_000, message: `${p.name} shows “${text}”` }).toBe(true);
    }
  } finally {
    for (const done of cleanup.reverse()) await done();
  }
});
