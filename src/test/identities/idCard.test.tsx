import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AddIdCardFace, IdCardFace } from "../../components/identities/IdCardFace";
import { contactGhostlyCard, ghostlyCard, idCard, idCardTone, machineLine, shortKey } from "../../components/identities/idCard";
import type { Translate } from "../../contexts/I18nContext";
import { date } from "../../lib/identities";
import en from "../../locales/en.json";
import { renderApp } from "../render";
import { DAY, now, proofView } from "./views";

// covers: proofs.deck, proofs.expiry, proofs.revoke, proofs.ghostly-card

/** English, the way `t()` reads it. */
const t: Translate = (key, params) => {
  let text = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], en) as string;
  for (const [k, v] of Object.entries(params ?? {})) text = text.replace(`{{${k}}}`, String(v));
  return text;
};
const KEY = "yzk3gq8qpjb1g4mzr3ff3kr1j4c1b7dxy8dd3mkwqc9k7p3e1mio";

const NOSTR = "npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m";

describe("what an ID card says", () => {
  it("a fresh proof is verified, valid until its expiry, and not shared", () => {
    const t = now();
    const card = idCard(proofView({ issuedAt: t - DAY, expiresAt: t + 30 * DAY }), { now: t });
    expect(card).toMatchObject({ status: "verified", statusLabel: "Verified", label: "Domain", short: "example.com", category: "Your own key", attested: false, shared: "Not shared", refusedBy: [] });
    expect(card.validity).toBe(`Valid until ${date(t + 30 * DAY)}`);
    expect(card.issued).toBe(date(t - DAY));
  });

  it("a proof in its last days is expiring, and says in how many", () => {
    const t = now();
    expect(idCard(proofView({ issuedAt: t - 28 * DAY, expiresAt: t + 2 * DAY }), { now: t })).toMatchObject({ status: "expiring", statusLabel: "Expires in 2 days" });
    expect(idCard(proofView({ issuedAt: t - 6 * DAY, expiresAt: t + 3600 }), { now: t })).toMatchObject({ status: "expiring", statusLabel: "Expires in 1 day" });
  });

  it("an expired proof says since when, whatever else is true of it", () => {
    const t = now();
    const card = idCard(proofView({ expiresAt: t - DAY }), { now: t, refusedBy: ["Alice"] });
    expect(card).toMatchObject({ status: "expired", statusLabel: "Expired", validity: `Expired ${date(t - DAY)}` });
  });

  it("a proof a contact's app refused failed its check, and names who refused it", () => {
    const t = now();
    // Refused wins over expiring: something is wrong now, not only soon.
    const card = idCard(proofView({ issuedAt: t - 28 * DAY, expiresAt: t + 2 * DAY }), { now: t, refusedBy: ["Alice", "Bob"] });
    expect(card).toMatchObject({ status: "failed", statusLabel: "Check failed", refusedBy: ["Alice", "Bob"] });
  });

  it("a proof being removed is being revoked, whatever its state", () => {
    const t = now();
    expect(idCard(proofView({ expiresAt: t - DAY }), { now: t, revoking: true })).toMatchObject({ status: "revoking", statusLabel: "Revoking…" });
    expect(idCard(proofView(), { revoking: true, refusedBy: ["Alice"] }).status).toBe("revoking");
  });

  it("says who attests an account, and counts the chats it is shared in", () => {
    const card = idCard(proofView({ provider: "oidc", sharedWith: 2, verified: { subject: "https://accounts.google.com#1234", source: "ID token", attester: "accounts.google.com" } }));
    expect(card).toMatchObject({ attested: true, category: "Attested by accounts.google.com", shared: "Shared in 2 chats", subject: "https://accounts.google.com#1234" });
    expect(idCard(proofView({ sharedWith: 1 })).shared).toBe("Shared in 1 chat");
  });

  it("shortens the subject the way its provider does, and takes a picture only as a data URL", () => {
    const address = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
    expect(idCard(proofView({ provider: "bitcoin", subject: address, verified: { subject: address, source: "BIP-322" } })).short).toBe("tb1qw50…jzsx · test network");
    const nostr = idCard(proofView({ provider: "nostr", subject: NOSTR, verified: { subject: NOSTR, source: "Nostr signature", display: { name: "Alice", avatar: "data:image/jpeg;base64,AAAA", source: "kind 0", fetchedAt: 0 } } }));
    expect(nostr).toMatchObject({ name: "Alice", photo: "data:image/jpeg;base64,AAAA" });
    const remote = idCard(proofView({ verified: { subject: "example.com", source: "DNS", display: { avatar: "https://example.com/me.png", source: "x", fetchedAt: 0 } } }));
    expect(remote.photo).toBeUndefined();
  });

  it("wears its provider's ink, or a key's when its provider has no mark", () => {
    expect(idCardTone({ provider: "nostr", subject: NOSTR })).toBe("id-card-nostr");
    // An account's mark is its provider's, named by the statement (the issuer), not by the account it proved.
    expect(idCardTone({ provider: "oidc", subject: "https://accounts.google.com" })).toBe("id-card-oidc-google");
    expect(idCard(proofView({ provider: "oidc", subject: "https://accounts.google.com", verified: { subject: "https://accounts.google.com#1", source: "ID token", attester: "accounts.google.com" } })).bound).toBe("https://accounts.google.com");
    expect(idCardTone({ provider: "some-plugin", subject: "x" })).toBe("id-card-key");
    expect(idCardTone({ provider: "some-plugin", subject: "x", attested: true })).toBe("id-card-attested");
  });

  it("writes a machine-readable line of 44 characters in its alphabet", () => {
    const line = machineLine("Nostr", NOSTR);
    expect(line).toHaveLength(44);
    expect(line).toMatch(/^ID<GHOSTLY<<NOSTR<<NPUB1[A-Z0-9<]+$/);
    expect(machineLine("Domain", "a.io")).toBe("ID<GHOSTLY<<DOMAIN<<A<IO".padEnd(44, "<"));
  });
});

describe("the ID card's face", () => {
  const face = (patch = {}, options = {}) => render(<IdCardFace card={idCard(proofView(patch), options)} />).container.firstElementChild as HTMLElement;

  it.each([
    ["verified", {}, {}, "Verified"],
    ["expiring", { issuedAt: now() - 28 * DAY, expiresAt: now() + 2 * DAY }, {}, "Expires in 2 days"],
    ["expired", { expiresAt: now() - DAY }, {}, "Expired"],
    ["failed", {}, { refusedBy: ["Alice"] }, "Check failed"],
    ["revoking", {}, { revoking: true }, "Revoking…"],
  ] as const)("shows a %s proof's status in its band", (status, patch, options, label) => {
    const el = face(patch, options);
    expect(el).toHaveAttribute("data-status", status);
    expect(el.querySelector(".id-card-status")).toHaveTextContent(label);
    // Only an expiring one carries the test id the dot's tests look for.
    expect(screen.queryAllByTestId("identity-proof-expiring")).toHaveLength(status === "expiring" ? 1 : 0);
  });

  it("is a deck face, with the parts the deck's motion moves", () => {
    const el = face();
    expect(el).toHaveAttribute("data-deck", "face");
    expect(el.querySelector("[data-deck=sheen]")).not.toBeNull();
    expect(el.querySelector("[data-deck=ghost]")).not.toBeNull();
  });

  it("puts the identity's picture in the photo slot, or else its provider's mark", () => {
    const withPhoto = face({ verified: { subject: "example.com", source: "DNS", display: { avatar: "data:image/jpeg;base64,AAAA", source: "x", fetchedAt: 0 } } });
    expect(withPhoto.querySelector(".id-card-photo img")).toHaveAttribute("src", "data:image/jpeg;base64,AAAA");
    const without = face({ provider: "nostr", subject: NOSTR, verified: { subject: NOSTR, source: "Nostr" } });
    expect(without.querySelector(".id-card-photo img")).toBeNull();
    expect(without.querySelector(".id-card-photo [data-icon=nostr]")).not.toBeNull();
  });

  it("the blank card invites an identity, then another, with the kinds it can add as marks", () => {
    const { rerender } = renderApp(<AddIdCardFace first providers={["nostr", "domain"]} />);
    expect(screen.getByText("Add an identity")).toBeInTheDocument();
    expect(screen.getByTestId("id-card-providers").querySelectorAll(".id-deck-mark")).toHaveLength(2);
    rerender(<AddIdCardFace first={false} />);
    expect(screen.getByText("Add another identity")).toBeInTheDocument();
    expect(screen.queryByTestId("id-card-providers")).not.toBeInTheDocument();
  });

  it("puts the name's initial in the photo slot of a card without a picture, with the provider's mark on its corner", () => {
    const { rerender } = render(<IdCardFace card={ghostlyCard(t, { nick: "Ghost", shareProfile: true }, {})} />);
    expect(screen.getByTestId("id-card-monogram")).toHaveTextContent("G");
    expect(document.querySelector(".id-card-photo-badge [data-icon=ghostly]")).not.toBeNull();
    rerender(<IdCardFace card={ghostlyCard(t, { nick: "Ghost", avatar: "data:image/jpeg;base64,AAAA", shareProfile: true }, {})} />);
    expect(screen.queryByTestId("id-card-monogram")).not.toBeInTheDocument();
    expect(document.querySelector(".id-card-photo img")).toHaveAttribute("src", "data:image/jpeg;base64,AAAA");
    // Its machine line names the profile, not the provider twice.
    expect(document.querySelector(".id-card-mrz")).toHaveTextContent("ID<GHOSTLY<<GHOSTLY<<GHOST<<");
  });
});

describe("the Ghostly card", () => {
  it("is the profile's name and picture, Default, with one key per chat and how many chats use it", () => {
    const card = ghostlyCard(t, { nick: "Ghost", avatar: "data:image/jpeg;base64,AAAA", shareProfile: true }, { chats: 3, since: Date.UTC(2026, 0, 2) });
    expect(card).toMatchObject({ id: "ghostly", provider: "ghostly", label: "Ghostly", name: "Ghost", photo: "data:image/jpeg;base64,AAAA", monogram: undefined,
      subject: "One key per chat", short: "One key per chat", category: "Your own keys", attested: false, status: "default", statusLabel: "Default", shared: "Used in 3 chats", refusedBy: [] });
    expect(card.validity).toBe(`Since ${date(Date.UTC(2026, 0, 2) / 1000)}`);
    expect(card.mrz).toBe("ID<GHOSTLY<<GHOSTLY<<GHOST".padEnd(44, "<"));
    expect(ghostlyCard(t, { nick: "Ghost", shareProfile: true }, { chats: 1 }).shared).toBe("Used in 1 chat");
    expect(ghostlyCard(t, { nick: "Ghost", shareProfile: true }, {})).toMatchObject({ shared: "No chats yet", validity: "What contacts see by default", issued: "", monogram: "G" });
    expect(idCardTone(card)).toBe("id-card-ghostly");
  });

  it("in a chat, shows that chat's key, shortened, and that the contact sees it", () => {
    const card = ghostlyCard(t, { nick: "Ghost", shareProfile: true }, { chat: { key: KEY, contact: "Alice" } });
    expect(card).toMatchObject({ subject: KEY, short: shortKey(KEY), category: "Your key in this chat", shared: "Shared with Alice" });
    expect(shortKey(KEY)).toBe("yzk3gq8q…1mio");
    expect(shortKey("me")).toBe("me");
  });

  it("says the name and picture are hidden when the profile does not share them, and has no name to show", () => {
    const card = ghostlyCard(t, { nick: "Ghost", avatar: "data:image/jpeg;base64,AAAA", shareProfile: false }, {});
    expect(card).toMatchObject({ name: "Name and picture hidden", photo: undefined, monogram: undefined });
    expect(ghostlyCard(t, { nick: "", shareProfile: true }, {}).name).toBe("No name yet");
    // A picture is a data URL or nothing.
    expect(ghostlyCard(t, { nick: "Ghost", avatar: "https://example.com/x.png", shareProfile: true }, {}).photo).toBeUndefined();
  });

  it("a contact's is the name and picture they sent, their key in this chat, and whether it is verified", () => {
    const since = Date.UTC(2026, 2, 3);
    const card = contactGhostlyCard(t, { peerNick: "Alice", peerAvatar: "data:image/jpeg;base64,BBBB", peerPubKeyZ32: KEY, peerVerified: true, createdAt: since }, "Contact · yzk3gq");
    expect(card).toMatchObject({ id: "ghostly", provider: "ghostly", name: "Alice", photo: "data:image/jpeg;base64,BBBB", subject: KEY, short: shortKey(KEY),
      category: "Their key in this chat", status: "default", statusLabel: "Verified", validity: `Chat since ${date(since / 1000)}` });
    expect(card.mrz).toBe("ID<GHOSTLY<<GHOSTLY<<ALICE".padEnd(44, "<"));
    // No name sent: the fallback names them, and the machine line carries the key instead.
    const unnamed = contactGhostlyCard(t, { peerNick: "", peerPubKeyZ32: KEY, peerVerified: false, createdAt: 0 }, "Contact · yzk3gq");
    expect(unnamed).toMatchObject({ name: "Contact · yzk3gq", monogram: undefined, statusLabel: "Not verified", validity: "What they show you by default", issued: "" });
    expect(unnamed.mrz).toMatch(/^ID<GHOSTLY<<GHOSTLY<<YZK3GQ8Q<1MIO<+$/);
  });
});
