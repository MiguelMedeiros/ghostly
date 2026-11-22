import { act, screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GroupMemberView } from "@ghostly/browser/shared/types";
import type { NostrOwnView } from "@ghostly/browser/nostr/types";
import { AccountBar } from "../../components/AccountBar";
import { MobileTabBar } from "../../components/MobileTabBar";
import { NeedsYouList } from "../../components/NeedsYou";
import { IdentityStack } from "../../components/identities/ContactMarks";
import { NostrSection } from "../../components/nostr/NostrSection";
import { NetworkTabs } from "../../components/wallet/NetworkTabs";
import { groupTransports } from "../../lib/groups";
import { renameProfile } from "../../lib/profiles";
import type { Language } from "../../lib/settings";
import { translateWith } from "../../locales/translate";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";
import { LOCALES, lookup } from "./locales";

// covers: app.i18n

/**
 * Lines and accessible names put together from translated parts: a list is joined the way the language lists ("、" in
 * Japanese and Chinese, "و" in Arabic), and "label: value" or two sentences take the language's own punctuation, never
 * an English ", ", ": " or ". " between translated words.
 */

const t = (language: Language) => translateWith(LOCALES[language], language);
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: "k", role: "member", me: false, online: true, missing: 0, ...patch });

describe("the group's transports line", () => {
  const members = [
    member({ key: "me", me: true }),
    member({ key: "a", edge: { state: "open", transport: "webrtc/1" } as GroupMemberView["edge"] }),
    member({ key: "b", edge: { state: "open", transport: "webrtc/1" } as GroupMemberView["edge"] }),
    member({ key: "c", edge: { state: "open", transport: "iroh/1" } as GroupMemberView["edge"] }),
    member({ key: "d" }),
  ];

  it("lists each transport the way the language lists", () => {
    expect(groupTransports(members)?.line).toBe("3 of 4 live · 2 WebRTC, 1 Iroh");
    expect(groupTransports(members, t("ja"))?.line).toMatch(/2 WebRTC、1 Iroh$/);
    expect(groupTransports(members, t("zh"))?.line).toMatch(/2 WebRTC、1 Iroh$/);
    expect(groupTransports(members, t("ar"))?.line).toMatch(/2 WebRTC و1 Iroh$/);
  });
});

describe("the own Nostr mute list", () => {
  const own: NostrOwnView = { subject: "a".repeat(64), npub: "npub1own", mute: { fetchedAt: 1, relays: ["wss://relay.test"], pubkeys: 3, words: 4, notes: 5, hasPrivate: false } };

  it.each([["ja", "、"], ["zh", "、"], ["ar", " و"]] as const)("in %s, counts its parts in the language's list", (language, between) => {
    renderApp(<NostrSection />, { language });
    act(() => fakeEngine.update({ nostr: { own: [own], settings: { relays: ["wss://relay.test"], autoLoadProfiles: false, publish: false } } }));
    const line = screen.getByTestId("nostr-own-mute").textContent!;
    expect(line).not.toMatch(/, /);
    expect(line).toContain(between);
  });
});

describe("the chat header's mark of a contact who shared nothing", () => {
  it.each(["ja", "zh"] as const)("in %s, ends its first sentence the language's way", (language) => {
    renderApp(<IdentityStack peerKey="peer" name="Alice" onOpen={() => {}} />, { language });
    const name = screen.getByTestId("chat-identity-badges").getAttribute("aria-label")!;
    expect(name).toContain(`${lookup(language, "identities.ghostly.theirs")}。`);
    expect(name).not.toMatch(/\. /);
  });
});

describe("accessible names put together from parts", () => {
  beforeEach(() => {
    fakeEngine.features = { ...fakeEngine.features, profiles: true };
    renameProfile("", "Personal");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ defaultNickname: "Miguel" }));
  });
  afterEach(() => { fakeEngine.features = { ...fakeEngine.features, profiles: false }; });

  it("the account bar's Profile and Identities, and the switcher's current profile, in Japanese", async () => {
    const { user } = renderApp(<Routes><Route path="/" element={<AccountBar />} /></Routes>, { language: "ja" });
    const profile = screen.getByTestId("account-profile");
    expect(profile.getAttribute("aria-label")).toMatch(/^プロフィール：Personal、[^,]+、オンライン|オフライン$/);
    expect(profile).toHaveAttribute("title", "プロフィール：Personal");
    await user.click(profile);
    const current = within(screen.getByRole("menu")).getByTestId("profile-switcher-current");
    expect(current.getAttribute("aria-label")).toMatch(new RegExp(`^Personal、[^,]+、${lookup("ja", "profileSwitcher.current")}。${lookup("ja", "profileSwitcher.open")}$`));
  });

  it("the phone's Settings tab, in Arabic", () => {
    renderApp(<Routes><Route path="/" element={<MobileTabBar />} /></Routes>, { language: "ar" });
    expect(screen.getByTestId("mobile-tab-settings").getAttribute("aria-label")).not.toMatch(/, /);
  });

  it("a wallet network tab that needs a look, in Chinese", () => {
    renderApp(<NetworkTabs network="mainnet" counts={{ mainnet: 1, testnet: 2 }} onChange={() => {}} label="x" testId="tabs" tabTestId="tab" idPrefix="p" controls="c" marked={{ testnet: true }} />, { language: "zh" });
    expect(screen.getByTestId("tab-testnet").getAttribute("aria-label")).toMatch(new RegExp(`、${lookup("zh", "common.needsYou.mark")}$`));
  });

  it("Show on a line waiting for the person, in Japanese", () => {
    renderApp(<NeedsYouList items={[{ id: "x", text: "バックアップ", show: () => {} } as never]} />, { language: "ja" });
    expect(screen.getByRole("button")).toHaveAccessibleName(`${lookup("ja", "common.needsYou.show")}：バックアップ`);
  });
});

describe("the Chinese Bluesky sign-in", () => {
  it("names the handle field in Chinese, as its Nostr field", () => {
    for (const signer of ["atproto-oauth", "atproto-oauth-full"]) {
      expect(lookup("zh", `identities.providers.atproto.signers.${signer}.fields.handle.label`)).toBe(lookup("zh", "identities.nostr.handle"));
    }
  });
});
