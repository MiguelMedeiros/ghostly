import { bech32m } from "@scure/base";
import { copyInvite, manualFallback, pasteInvite } from "../support/clipboard";
import { chat, expect, say, test, type Peer } from "../support/fixtures";

/**
 * The one invite of WISP 801: a new chat makes a `ghostly1` code, the card copies it as its link on
 * ghostly.tools, and Join takes the link, the bare code or the QR (which holds the link in capitals).
 */

async function newInvite(host: Peer): Promise<{ link: string; code: string }> {
  await host.page.getByTitle("New Chat").click();
  const link = await copyInvite(host.page);
  expect(link).toMatch(/^https:\/\/ghostly\.tools\/#ghostly1p[02-9ac-hj-np-z]{211}$/);
  return { link, code: link.split("#")[1] };
}

async function openJoin(guest: Peer) {
  await guest.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
}

/** Both sides can write, and a message goes each way. */
async function talk(host: Peer, guest: Peer, words: string) {
  for (const p of [host, guest]) await expect(p.page.getByPlaceholder("Message…")).toBeEnabled();
  await say(guest, words);
  await expect(chat(host).getByText(words)).toBeVisible();
  await say(host, `re: ${words}`);
  await expect(chat(guest).getByText(`re: ${words}`)).toBeVisible();
}

test("an invite joins by its link, by the bare code and by its QR", { tag: ["@feature:invite.code", "@feature:invite.pin", "@feature:invite.clipboard", "@feature:invite.qr.image", "@feature:chat.paired.pair"] }, async ({ peer }) => {
  const [alice, bob, carol, dave] = await Promise.all([peer("alice"), peer("bob"), peer("carol"), peer("dave")]);

  // The link, pasted as copied.
  const first = await newInvite(alice);
  await expect(alice.page.getByTestId("invite-link")).toHaveText(first.link.replace("https://", ""));
  await openJoin(bob);
  await pasteInvite(bob.page, first.link);
  await talk(alice, bob, "in by the link");

  // The bare code, typed into the field.
  const second = await newInvite(alice);
  await openJoin(carol);
  await manualFallback(carol.page);
  await carol.page.getByPlaceholder("Paste invite…").fill(second.code);
  await carol.page.getByRole("dialog").getByRole("button", { name: "Join chat", exact: true }).click();
  await talk(alice, carol, "in by the code");

  // The QR, as an image: it holds HTTPS://GHOSTLY.TOOLS/#GHOSTLY1…, which Join reads in any case.
  await newInvite(alice);
  const qr = await alice.page.getByTestId("invite-qr").screenshot();
  await openJoin(dave);
  await dave.page.getByLabel("Open image").setInputFiles({ name: "invite.png", mimeType: "image/png", buffer: qr });
  await talk(alice, dave, "in by the QR");
});

test("Join says why it refuses a code, and joins nothing", { tag: ["@feature:invite.code", "@feature:invite.invalid"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  const { code } = await newInvite(alice);
  const words = bech32m.decode(code, 1023).words.slice(1);
  const bytes = bech32m.fromWords(words);
  const cases: [string, string][] = [
    [code.slice(0, 60) + (code[60] === "q" ? "p" : "q") + code.slice(61), "This code has a typo. Check it, or ask for the code again."],
    [bech32m.encode("ghostly", [2, ...words], false), "This invite was made by a newer Ghostly. Update to join."],
    [bech32m.encode("ghostly", [0, ...words], false), "This is not a Ghostly invite."],
    ["npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m", "This is not a Ghostly invite."],
    [bech32m.encode("ghostly", [1, ...bech32m.toWords(bytes.slice(0, 96))], false), "This invite is damaged. Ask for a new one."],
  ];
  await openJoin(bob);
  await manualFallback(bob.page);
  const field = bob.page.getByPlaceholder("Paste invite…");
  for (const [value, message] of cases) {
    await field.fill(`https://ghostly.tools/#${value}`);
    await bob.page.getByRole("dialog").getByRole("button", { name: "Join chat", exact: true }).click();
    await expect(bob.page.getByRole("dialog").getByRole("alert")).toHaveText(message);
  }
  await expect(bob.page.getByRole("dialog")).toBeVisible();
  expect(await bob.page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("ghostly_invite_") || /"mySeedB64"/.test(localStorage.getItem(key) ?? "")).length)).toBe(0);
});
