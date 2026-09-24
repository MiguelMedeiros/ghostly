import { screen } from "@testing-library/react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { Page } from "../../components/layout";
import { useAppNavigation } from "../../hooks/useAppNavigation";
import {
  HOME, NAV_KEY, conversationTarget, hasParent, homeTarget, navOnly, openTarget, openUnderTarget, placeTarget, plan, readNav, stackOf,
  upTarget, userState, type NavEntry,
} from "../../lib/navigation";
import { renderApp } from "../render";

// covers: app.navigation.back

/** The stack an entry would carry after the app navigated there through these entries (home first). */
const at = (...entries: NavEntry[]) => {
  const last = entries.length - 1;
  return stackOf(entries[last].path, entries[last].path === HOME ? null : { [NAV_KEY]: { below: entries.slice(1, last), up: !!entries[last].up } });
};
const home = { path: HOME }, chat = { path: "/chat/s1" }, wallet = { path: "/wallet" }, settings = { path: "/settings" };

describe("navigation plan", () => {
  it("a place opened from home is pushed on it; another place replaces it; home is going back", () => {
    expect(plan(at(home), placeTarget(at(home), "/wallet"))).toMatchObject({ back: 0, push: [{ path: "/wallet" }] });
    const fromWallet = plan(at(home, wallet), placeTarget(at(home, wallet), "/identities"));
    expect(fromWallet).toMatchObject({ back: 0, replace: { path: "/identities" }, push: [] });
    expect(readNav(fromWallet.replace!.state)).toEqual({ below: [], up: false });
    expect(plan(at(home, { path: "/identities" }), homeTarget())).toEqual({ back: 1, push: [] });
  });

  it("a place opened over a chat stays on it, so the browser's Back returns to the chat; the page's Back goes home", () => {
    const over = placeTarget(at(home, chat), "/settings");
    expect(over).toEqual([home, chat, settings]);
    const steps = plan(at(home, chat), over);
    expect(steps).toMatchObject({ back: 0, push: [{ path: "/settings" }] });
    expect(readNav(steps.push[0].state)).toEqual({ below: [chat], up: false });
    // Another place from there replaces Settings, still over the chat.
    expect(plan(at(home, chat, settings), placeTarget(at(home, chat, settings), "/wallet"))).toMatchObject({ back: 0, replace: { path: "/wallet" }, push: [] });
    expect(upTarget(at(home, chat, settings))).toEqual(homeTarget());
    expect(plan(at(home, chat, settings), upTarget(at(home, chat, settings)))).toEqual({ back: 2, push: [] });
  });

  it("a conversation always sits on home, whatever was open", () => {
    expect(plan(at(home, chat), conversationTarget("/group/g1"))).toMatchObject({ back: 0, replace: { path: "/group/g1" }, push: [] });
    expect(plan(at(home, chat, settings), conversationTarget("/chat/s2"))).toMatchObject({ back: 1, replace: { path: "/chat/s2" }, push: [] });
    expect(plan(at(home, settings, { path: "/profile", up: true }), placeTarget(at(home), "/chat/s2"))).toMatchObject({ back: 1, replace: { path: "/chat/s2" } });
  });

  it("a sub-page is pushed on its parent and goes up to it; a page already below is gone back to, not stacked", () => {
    const profile = { path: "/profile", up: true };
    expect(openTarget(at(home, settings), "/profile")).toEqual([home, settings, profile]);
    const steps = plan(at(home, settings), openTarget(at(home, settings), "/profile"));
    expect(readNav(steps.push[0].state)).toEqual({ below: [settings], up: true });
    expect(hasParent(at(home, settings, profile))).toBe(true);
    expect(upTarget(at(home, settings, profile))).toEqual([home, settings]);
    expect(plan(at(home, settings, profile), upTarget(at(home, settings, profile)))).toEqual({ back: 1, push: [] });
    // Profile → Settings, which is right below: back to it rather than Settings → Profile → Settings → …
    expect(plan(at(home, settings, profile), openTarget(at(home, settings, profile), "/settings"))).toEqual({ back: 1, push: [] });
    // Profile → Wallets is a sub-page of Profile.
    expect(openTarget(at(home, settings, profile), "/wallet")).toEqual([home, settings, profile, { path: "/wallet", up: true }]);
    // A place from a sub-page: the sub-page and its parent go, the place sits on home.
    expect(plan(at(home, settings, profile), placeTarget(at(home, settings, profile), "/identities"))).toMatchObject({ back: 1, replace: { path: "/identities" }, push: [] });
    // "Chats" on a page is home.
    expect(openTarget(at(home, settings, profile), HOME)).toEqual(homeTarget());
  });

  it("a page opened from a chat goes up to the chat", () => {
    const identities = { path: "/identities", up: true };
    expect(openTarget(at(home, chat), "/identities")).toEqual([home, chat, identities]);
    expect(upTarget(at(home, chat, identities))).toEqual([home, chat]);
  });

  it("a phone's Profile, from the account switcher, lives under Settings wherever it is opened", () => {
    const target = openUnderTarget("/settings", "/profile");
    expect(plan(at(home, wallet), target, { newProfile: true })).toMatchObject({
      back: 0, replace: { path: "/settings" }, push: [{ path: "/profile", state: { newProfile: true } }],
    });
    // Already on Settings: pushed on it, with the page's state.
    expect(plan(at(home, settings), target, { newProfile: true })).toMatchObject({ back: 0, push: [{ path: "/profile", state: { newProfile: true } }] });
  });

  it("an entry that knows nothing below it (a deep link) gets home put under it", () => {
    const deep = stackOf("/group/g1", null);
    expect(deep).toEqual({ entries: [{ path: "/group/g1" }], rooted: false });
    const steps = plan(deep, [home, { path: "/group/g1" }]);
    expect(steps).toMatchObject({ back: 0, replace: { path: HOME }, push: [{ path: "/group/g1" }] });
    expect(readNav(steps.push[0].state)).toEqual({ below: [], up: false });
    // A place from an entry like that is built on home too.
    expect(placeTarget(stackOf("/wallet", null), "/settings")).toEqual([home, settings]);
    expect(upTarget(stackOf("/wallet", null))).toEqual(homeTarget());
  });

  it("the same place twice changes nothing; new page state replaces the entry where it is", () => {
    expect(plan(at(home, wallet), placeTarget(at(home, wallet), "/wallet"))).toEqual({ back: 0, push: [] });
    expect(plan(at(home, wallet), placeTarget(at(home, wallet), "/wallet"), { tab: 1 })).toMatchObject({ back: 0, replace: { path: "/wallet", state: { tab: 1 } }, push: [] });
  });

  it("keeps the page's own state apart from the record, and rejects a malformed record", () => {
    const state = { share: "created", [NAV_KEY]: { below: [chat], up: false } };
    expect(userState(state)).toEqual({ share: "created" });
    expect(userState({ [NAV_KEY]: { below: [], up: false } })).toBeUndefined();
    expect(navOnly(state)).toEqual({ [NAV_KEY]: { below: [chat], up: false } });
    expect(navOnly({ share: "created" })).toBeNull();
    expect(readNav({ [NAV_KEY]: { below: "nope" } })).toBeNull();
    expect(readNav({ [NAV_KEY]: { below: [{ path: 3 }] } })).toBeNull();
    expect(readNav(null)).toBeNull();
  });
});

/** A small app: the account bar's places, a link inside Settings, and the browser's Back. */
function Harness() {
  const nav = useAppNavigation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (
    <>
      <p data-testid="where">{pathname}</p>
      <button onClick={() => nav.place("/wallet")}>Wallets</button>
      <button onClick={() => nav.place("/identities")}>Identities</button>
      <button onClick={() => nav.place("/settings")}>Settings</button>
      <button onClick={() => nav.conversation("/chat/s1")}>Chat</button>
      <button onClick={() => void navigate(-1)}>Browser back</button>
      <Routes>
        <Route path="/" element={<p>New and Join</p>} />
        <Route path="/chat/:id" element={<p>A chat</p>} />
        <Route path="/wallet" element={<Page title="Wallet"><p>Wallet body</p></Page>} />
        <Route path="/identities" element={<Page title="Identities"><p>Identities body</p></Page>} />
        <Route path="/settings" element={<Page title="Settings"><button onClick={() => nav.open("/profile")}>Profile link</button></Page>} />
        <Route path="/profile" element={<Page title="Profile"><p>Profile body</p></Page>} />
      </Routes>
    </>
  );
}

describe("useAppNavigation", () => {
  const where = () => screen.getByTestId("where").textContent;

  it("Back after Wallets → Identities → Settings goes home, not back through them", async () => {
    const { user } = renderApp(<Harness />);
    for (const place of ["Wallets", "Identities", "Settings"]) await user.click(screen.getByRole("button", { name: place }));
    expect(where()).toBe("/settings");
    expect(screen.getByTestId("page-back")).toHaveAttribute("data-goes", "home");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(where()).toBe("/");
    expect(screen.getByText("New and Join")).toBeInTheDocument();
  });

  it("the browser's Back from a place goes home, not to the place before", async () => {
    const { user } = renderApp(<Harness />);
    await user.click(screen.getByRole("button", { name: "Wallets" }));
    await user.click(screen.getByRole("button", { name: "Identities" }));
    await user.click(screen.getByRole("button", { name: "Browser back" }));
    expect(where()).toBe("/");
  });

  it("a place opened from a chat: the browser's Back returns to the chat, the page's Back goes home", async () => {
    const { user } = renderApp(<Harness />);
    await user.click(screen.getByRole("button", { name: "Chat" }));
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Browser back" }));
    expect(where()).toBe("/chat/s1");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(where()).toBe("/");
  });

  it("a sub-page goes up to its parent, then home", async () => {
    const { user } = renderApp(<Harness />);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Profile link" }));
    expect(where()).toBe("/profile");
    expect(screen.getByTestId("page-back")).toHaveAttribute("data-goes", "up");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(where()).toBe("/settings");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(where()).toBe("/");
  });

  it("a place from a sub-page replaces both: Back from it goes home", async () => {
    const { user } = renderApp(<Harness />);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Profile link" }));
    await user.click(screen.getByRole("button", { name: "Wallets" }));
    expect(where()).toBe("/wallet");
    await user.click(screen.getByRole("button", { name: "Browser back" }));
    expect(where()).toBe("/");
  });
});
