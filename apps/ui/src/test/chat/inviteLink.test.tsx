import { act, render, screen, waitFor } from "@testing-library/react";
import { createChatInvite, createDeviceInvite } from "@ghostly/core";
import { afterEach, expect, it, describe } from "vitest";
import { Root } from "../../Root";
import { deleteSession, ensureSession, listSessions, LINK_CHATS_WAITING, linkChatsWaiting, saveSession } from "../../lib/storage";
import { readInvite, inviteRouteCode } from "../../lib/url";
import { takeDeviceLink, takeDeviceLinkFromAddress } from "../../lib/devices";
import { fakeEngine } from "../fakeEngine";

// covers: invite.link
describe("the address of a chat no longer on this device", () => {
  /*
   * The address of a chat no longer on this device (a bookmark, a link kept from before it was deleted) says the chat is
   * gone, as a group's does; the person was not opening an invite. A code that looks like an invite keeps its refusal.
   */

  afterEach(() => { window.location.hash = ""; });

  /** The address is set on the running page. */
  function go(hash: string): void {
    window.location.hash = hash;
    // A browser says a fragment navigation with `popstate` (what the router listens to); happy-dom says only `hashchange`.
    act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
  }

  it("a deleted chat's address says the chat is gone from this device, not that it is no invite", async () => {
    const reading = readInvite(createChatInvite().inviteCode);
    if (!reading.ok) throw new Error("a fresh invite reads");
    const id = ensureSession(reading.keys);
    deleteSession(id);
    expect(listSessions()).toHaveLength(0);

    render(<Root />);
    go(`#/chat/${id}`);
    const notice = await screen.findByTestId("invite-link-invalid");
    expect(notice).toHaveTextContent("This chat is gone from this device.");
    expect(notice).not.toHaveTextContent("This is not a Ghostly invite.");
    await waitFor(() => expect(window.location.hash).toBe("#/"));
  });

  it("a code that looks like an invite keeps its refusal", async () => {
    render(<Root />);
    go("#/chat/ghostly1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq");
    const notice = await screen.findByTestId("invite-link-invalid");
    expect(notice).not.toHaveTextContent("This chat is gone from this device.");
    await waitFor(() => expect(window.location.hash).toBe("#/"));
  });
});

// covers: invite.link
describe("a link with a doubled `#` before it", () => {
  /*
   * A link with a doubled `#` before it (`##ghostly1…`, or the app's own `#/` with a `#…` after it) is the same link, for
   * every kind the intakes take: the router read it as home with a hash, and the link was left in the address with
   * nothing opened.
   */

  afterEach(() => { window.location.hash = ""; takeDeviceLink(); });

  it.each(["##{code}", "#/#{code}", "##{code}/", "##/chat/{code}", "#/#/chat/{code}", "##web+ghostly:{code}", "#/#web%2Bghostly%3A{code}"])("an invite opened as %s joins, and leaves the address", async (form) => {
    const code = createChatInvite().inviteCode;
    window.history.replaceState(null, "", form.replace("{code}", code));
    render(<Root />);
    await waitFor(() => expect(listSessions()).toHaveLength(1));
    await waitFor(() => expect(window.location.hash).toBe(`#/chat/${listSessions()[0].id}`));
  }, 60_000);

  it("an invite with more after a doubled `#` is refused, and leaves the address", async () => {
    const code = createChatInvite().inviteCode;
    window.history.replaceState(null, "", `##${code}/more`);
    render(<Root />);
    expect(await screen.findByTestId("invite-link-invalid")).toBeInTheDocument();
    expect(window.location.hash).toBe("#/");
    expect(listSessions()).toHaveLength(0);
  }, 60_000);

  /*
   * One with an extra `/` after the doubled `#` (`##//x#ghostly1…`) was read as another site's address, which the router
   * refuses: the app opened on "Something went wrong", again at each reload. It goes home, as `#//…` does.
   */
  it.each(["##//x#{code}", "#/#//x#{code}", "#/#/\\x#{code}", "##//{code}", "##//join/group2/abc", "##//chat/abc"])("%s goes home, and leaves the address", async (form) => {
    const code = createChatInvite().inviteCode;
    window.history.replaceState(null, "", form.replace("{code}", code));
    render(<Root />);
    expect(await screen.findByTestId("sidebar")).toBeInTheDocument();
    await waitFor(() => expect(window.location.hash).toBe("#/"));
    expect(screen.queryByText("Something went wrong")).toBeNull();
    expect(listSessions()).toHaveLength(0);
  }, 60_000);

  it.each(["##{code}", "#/#{code}"])("a device code given to the open app as %s goes to the join host, and leaves the address", async (form) => {
    render(<Root />);
    const code = createDeviceInvite(new Uint8Array(32).fill(7)).code;
    window.location.hash = form.replace("{code}", code);
    act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
    await waitFor(() => expect(window.location.hash).toBe("#/"));
    expect(await screen.findByTestId("device-join-confirm")).toBeInTheDocument();
    expect(screen.queryByTestId("invite-link-invalid")).toBeNull();
  }, 60_000);

  it.each(["##/join/group2/abc", "#/#/join/group2/abc"])("a group's link opened as %s joins, and leaves the address", async (form) => {
    fakeEngine.on("joinGroupByLink", () => ({ groupId: "g1" }));
    window.history.replaceState(null, "", form);
    render(<Root />);
    await waitFor(() => expect(window.location.hash).toBe("#/group/g1"));
  }, 60_000);
});

// covers: invite.link
describe("how many link-made chats may wait for an answer", () => {
  /*
   * An invite link opened in the app makes a chat with no act of the person's: a page can send the browser to one, and
   * a code needs nobody behind it. So only a few link-made chats may wait for an answer at once. Past that a link makes
   * nothing and says so, until one of them is answered or deleted. Join's paste and scan are not counted.
   */

  afterEach(() => { window.location.hash = ""; });

  /** The address is given another invite while the app is open. */
  async function follow(code: string): Promise<void> {
    window.location.hash = `#${code}`;
    // A browser says a fragment navigation with `popstate` (what the router listens to); happy-dom says only `hashchange`.
    act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
    // The code leaves the address whatever comes of it.
    await waitFor(() => expect(window.location.hash).not.toContain(code));
  }

  it("an invite link makes a chat only while few link-made chats wait for an answer", async () => {
    const codes = Array.from({ length: LINK_CHATS_WAITING + 3 }, () => createChatInvite().inviteCode);
    window.location.hash = `#${codes[0]}`;
    render(<Root />);
    await waitFor(() => expect(listSessions()).toHaveLength(1));
    for (let at = 1; at < codes.length - 1; at++) await follow(codes[at]);

    // The first ones each made a chat; the ones past the limit made none, and the app says why.
    expect(listSessions()).toHaveLength(LINK_CHATS_WAITING);
    expect(listSessions().every((session) => session.viaLink)).toBe(true);
    expect(await screen.findByTestId("invite-link-invalid")).toHaveTextContent("Too many invite links opened. Delete a chat that got no answer, or paste the invite in Join.");
    expect(window.location.hash).toBe("#/");

    // A link to a chat it already made still opens that chat.
    const first = listSessions().find((session) => session.mySeedB64 === (readInvite(codes[0]) as { keys: { seedB64: string } }).keys.seedB64)!;
    await follow(codes[0]);
    await waitFor(() => expect(window.location.hash).toBe(`#/chat/${first.id}`));
    expect(listSessions()).toHaveLength(LINK_CHATS_WAITING);

    // One of them is answered: a link makes a chat again.
    saveSession({ ...first, messages: [{ id: "m1", text: "hi", timestamp: Date.now(), sender: "peer" }] as never, lastSyncAt: Date.now() });
    expect(linkChatsWaiting()).toBe(LINK_CHATS_WAITING - 1);
    await follow(codes[codes.length - 1]);
    await waitFor(() => expect(listSessions()).toHaveLength(LINK_CHATS_WAITING + 1));
  }, 120_000);

  it("an invite the person pasted or scanned in Join is not counted, and is not held back", () => {
    for (let at = 0; at < LINK_CHATS_WAITING + 2; at++) {
      const reading = readInvite(createChatInvite().inviteCode);
      if (!reading.ok) throw new Error("a fresh invite reads");
      ensureSession(reading.keys);
    }
    expect(listSessions()).toHaveLength(LINK_CHATS_WAITING + 2);
    expect(linkChatsWaiting()).toBe(0);
  });
});

// covers: invite.link
describe("a link with a long run of `/`", () => {
  /*
   * Any address opens the app, and a link anyone sends may hold a long run of `/` that does not end it. Reading the `/`s a
   * link ends with took the square of that run (`/\/+$/`, a lazy code before `\/*$`): 100,000 of them froze the tab for
   * seconds at each read, before anything was drawn and again on the route, with the address left as it was.
   */

  const RUN = "/".repeat(100_000);

  afterEach(() => { window.location.hash = ""; takeDeviceLink(); });

  it("an invite route with a long run of `/` before more is read at once, and refused", () => {
    const started = performance.now();
    expect(inviteRouteCode(`/ghostly1${RUN}x`)).toBe(`ghostly1${RUN}x`);
    expect(inviteRouteCode(`/ghostly1abc${RUN}`)).toBe("ghostly1abc");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("an address with a long run of `/` before more is passed over at once when the app starts", () => {
    window.history.replaceState(null, "", `#/x${RUN}x`);
    const started = performance.now();
    takeDeviceLinkFromAddress();
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(takeDeviceLink()).toBeFalsy();
  });

  it.each([`#/ghostly1${RUN}x`, `#/Ana#${RUN}x`])("the open app reads such an address at once, and it leaves the address (%#)", async (form) => {
    render(<Root />);
    const started = performance.now();
    window.location.hash = form;
    act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
    await waitFor(() => expect(window.location.hash).toBe("#/"));
    expect(performance.now() - started).toBeLessThan(1_000);
    if (form.includes("ghostly1")) expect(await screen.findByTestId("invite-link-invalid")).toBeInTheDocument();
  }, 60_000);
});

// covers: invite.link
describe("a link whose code ends in a `/`", () => {
  /*
   * A link whose code ends in a `/` (typed by hand, or one a linkifier ended so) is the same link: the invite joins and a
   * device code goes to the join host, and the code leaves the address as it does without the `/`. Anything else after
   * the code is a link the app cannot read: refused, and out of the address. The page was blank, the code still in it.
   */

  afterEach(() => { window.location.hash = ""; takeDeviceLink(); });

  it.each(["#/{code}/", "#{code}/", "#{code}//"])("an invite opened as %s joins, and leaves the address", async (form) => {
    const code = createChatInvite().inviteCode;
    window.location.hash = form.replace("{code}", code);
    render(<Root />);
    await waitFor(() => expect(listSessions()).toHaveLength(1));
    await waitFor(() => expect(window.location.hash).toBe(`#/chat/${listSessions()[0].id}`));
  }, 60_000);

  it("an invite with more after its `/` is refused, and leaves the address", async () => {
    const code = createChatInvite().inviteCode;
    window.location.hash = `#/${code}/more`;
    render(<Root />);
    expect(await screen.findByTestId("invite-link-invalid")).toBeInTheDocument();
    expect(window.location.hash).toBe("#/");
    expect(listSessions()).toHaveLength(0);
  }, 60_000);

  it.each(["#{code}/", "#/{code}/", "#Ana#{code}/"])("a device code given to the open app as %s goes to the join host, and leaves the address", async (form) => {
    render(<Root />);
    const code = createDeviceInvite(new Uint8Array(32).fill(7)).code;
    window.location.hash = form.replace("{code}", code);
    act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
    await waitFor(() => expect(window.location.hash).toBe("#/"));
    // The join host took it: "Add this device to <profile>".
    expect(await screen.findByTestId("device-join-confirm")).toBeInTheDocument();
    expect(screen.queryByTestId("invite-link-invalid")).toBeNull();
  }, 60_000);

  it.each(["#{code}/", "#/{code}/", "#Ana#{code}/"])("a device code opened as %s goes to the join host, and leaves the address", (form) => {
    const code = createDeviceInvite(new Uint8Array(32).fill(7)).code;
    window.history.replaceState(null, "", form.replace("{code}", code));
    takeDeviceLinkFromAddress();
    expect(window.location.hash).toBe("#/");
    expect(takeDeviceLink()?.code).toBe(code);
  });
});

// covers: invite.link
describe("a device code's link whose name is a group's link", () => {
  /*
   * A device code's link names the profile before the code (`#<profile>#ghostly1z…`), and the name may read as a group's
   * link (`#/join/group2/…#ghostly1z…`, made by hand). A fresh page takes it as the device code alone. Given to the open
   * app it was taken twice: the group was joined and opened, and the device-join dialog came over it.
   */

  afterEach(() => { window.location.hash = ""; takeDeviceLink(); });

  it("given to the open app, it goes to the join host only: no group is joined", async () => {
    fakeEngine.on("joinGroupByLink", () => ({ groupId: "g1" }));
    render(<Root />);
    await screen.findByTestId("sidebar");
    const code = createDeviceInvite(new Uint8Array(32).fill(7)).code;
    window.location.hash = `#/join/group2/abc/def#${code}`;
    act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(await screen.findByTestId("device-join-confirm")).toBeInTheDocument();
    expect(window.location.hash).toBe("#/");
    expect(fakeEngine.callsTo("joinGroupByLink")).toHaveLength(0);
  }, 60_000);
});

// covers: invite.invalid, invite.link, groups.link.join
describe("a link's refusal, then a link of the other kind", () => {
  /*
   * A link's refusal stays until closed, or until the next link comes: that one answers for itself. The next link may be
   * of the other kind (an invite after a group's link, a group's link after an invite), and a refusal left there would
   * read as the refusal of the chat or group that opened, or sit on top of the other kind's refusal, hiding it.
   */

  afterEach(() => { window.location.hash = ""; });

  /** The address is set on the running page, as a browser says a fragment navigation (`popstate`). */
  function go(hash: string): void {
    window.location.hash = hash;
    act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
  }

  /** A fresh invite's code with its end cut off: a damaged link. */
  const damaged = () => createChatInvite().inviteCode.slice(0, -5);

  it("a group link's refusal goes when a good invite link opens its chat next", async () => {
    fakeEngine.on("joinGroupByLink", () => { throw new Error("Go online to join a group"); });
    render(<Root />);
    await screen.findByTestId("sidebar");
    go("#/join/group2/abc");
    await screen.findByTestId("group-link-invalid");

    go(`#${createChatInvite().inviteCode}`);
    await waitFor(() => expect(listSessions()).toHaveLength(1));
    await waitFor(() => expect(window.location.hash).toBe(`#/chat/${listSessions()[0].id}`));
    expect(screen.queryByTestId("group-link-invalid")).toBeNull();
  }, 60_000);

  it("a group link's join refused after a good invite link opened its chat is not said over that chat", async () => {
    let refuse: (cause: Error) => void = () => {};
    fakeEngine.on("joinGroupByLink", () => new Promise((_, reject) => { refuse = reject; }));
    render(<Root />);
    await screen.findByTestId("sidebar");
    go("#/join/group2/abc");
    await waitFor(() => expect(fakeEngine.callsTo("joinGroupByLink")).toHaveLength(1));

    go(`#${createChatInvite().inviteCode}`);
    await waitFor(() => expect(listSessions()).toHaveLength(1));
    await waitFor(() => expect(window.location.hash).toBe(`#/chat/${listSessions()[0].id}`));
    await act(async () => { refuse(new Error("Go online to join a group")); });
    expect(screen.queryByTestId("group-link-invalid")).toBeNull();
  }, 60_000);

  it("an invite link's refusal goes when a group's link opens its group next", async () => {
    fakeEngine.on("joinGroupByLink", () => ({ groupId: "g1" }));
    render(<Root />);
    await screen.findByTestId("sidebar");
    go(`#/${damaged()}`);
    await screen.findByTestId("invite-link-invalid");

    go("#/join/group2/def");
    await waitFor(() => expect(window.location.hash).toBe("#/group/g1"));
    expect(screen.queryByTestId("invite-link-invalid")).toBeNull();
  }, 60_000);

  it("two refused links of different kinds: only the last one's refusal is shown, not one on top of the other", async () => {
    render(<Root />);
    await screen.findByTestId("sidebar");
    go(`#/${damaged()}`);
    await screen.findByTestId("invite-link-invalid");

    go("#/join/%zz");
    await screen.findByTestId("group-link-invalid");
    expect(screen.queryByTestId("invite-link-invalid")).toBeNull();

    go(`#/${damaged()}`);
    await screen.findByTestId("invite-link-invalid");
    expect(screen.queryByTestId("group-link-invalid")).toBeNull();
  }, 60_000);
});
