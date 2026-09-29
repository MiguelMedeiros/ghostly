import { act, screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createIdentity, encodeGroupEntryLink } from "@ghostly/core";
import type { GroupMemberView, GroupView } from "@ghostly/browser/shared/types";
import { GroupShareDialog } from "../../components/GroupLinkPanel";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: groups.link.enable, groups.create

// A link decodes only with a real group id (22 characters) and a real entry key.
const ID = "AbCdEfGhIjKlMnOpQrStUv";
const LINK = encodeGroupEntryLink({ g: ID, host: createIdentity().pubKeyZ32 });
const URL_OF = `${window.location.origin}/#/join/${LINK}`;
const ME = "me".padEnd(52, "y");
const me: GroupMemberView = { key: ME, role: "admin", me: true, online: true, missing: 0 };
const admin = (patch: Partial<GroupView> = {}) => groupView({ id: ID, status: "active", epoch: 1, isAdmin: true, members: [me], ...patch });

function openGroup(group: GroupView) {
  fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined);
  fakeEngine.update({ groups: [group] });
  return renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: `/group/${ID}` });
}

describe("the group header's Share link", () => {
  it("is there for the admin of an active group only", () => {
    openGroup(admin({ isAdmin: false }));
    expect(screen.queryByTestId("group-share")).not.toBeInTheDocument();
  });

  it("opens the link, big, with Share and Copy", async () => {
    const { user } = openGroup(admin({ entryLink: LINK }));
    await user.click(screen.getByTestId("group-share"));
    const dialog = screen.getByTestId("group-share-dialog");
    expect(dialog).toHaveTextContent("Share Friends");
    expect(screen.getByRole("textbox", { name: "Group link" })).toHaveValue(URL_OF);
    expect(screen.getByTestId("group-link-note")).toHaveTextContent("Anyone who opens this link joins");
    // The big panel shows its QR at once.
    expect(screen.getByTestId("group-link-qr")).toBeInTheDocument();
    await user.click(screen.getByTestId("group-share-done"));
    expect(screen.queryByTestId("group-share-dialog")).not.toBeInTheDocument();
  });

  it("turns a link that is off on first", async () => {
    const { user, engine } = openGroup(admin());
    engine.on("enableGroupLink", () => {
      // The engine answers with the link, and the state that follows carries it.
      queueMicrotask(() => engine.update({ groups: [admin({ entryLink: LINK })] }));
      return { link: LINK };
    });
    await user.click(screen.getByTestId("group-share"));
    expect(engine.callsTo("enableGroupLink")).toEqual([{ groupId: ID }]);
    expect(await screen.findByTestId("group-share-dialog")).toBeInTheDocument();
  });

  it("says so when the link cannot be turned on", async () => {
    const { user, engine } = openGroup(admin());
    engine.on("enableGroupLink", () => { throw new Error("The group is full"); });
    await user.click(screen.getByTestId("group-share"));
    expect(await screen.findByTestId("group-notice")).toHaveTextContent("The group is full");
    expect(screen.queryByTestId("group-share-dialog")).not.toBeInTheDocument();
  });
});

describe("GroupShareDialog", () => {
  it("is where a new group ends: ready, and on to the group", async () => {
    const onClose = vi.fn();
    const { user } = renderApp(<GroupShareDialog group={admin({ entryLink: LINK })} created onClose={onClose} />);
    expect(screen.getByRole("heading", { name: "Friends is ready" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Go to the group" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("copies the link when this browser has no way to share it", async () => {
    // happy-dom has no Web Share API and the web app no share sheet: Share falls back to a copy, and says so.
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const { user } = renderApp(<GroupShareDialog group={admin({ entryLink: LINK })} onClose={() => {}} />);
    await user.click(screen.getByTestId("group-link-share"));
    expect(writeText).toHaveBeenCalledWith(URL_OF);
    expect(screen.getByTestId("group-link-copy")).toHaveTextContent("Copied");
  });

  it("says Shared when the browser shared it", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    try {
      const { user } = renderApp(<GroupShareDialog group={admin({ name: "", entryLink: LINK })} onClose={() => {}} />);
      await user.click(screen.getByTestId("group-link-share"));
      expect(share).toHaveBeenCalledWith({ title: "Join a group on Ghostly", url: URL_OF });
      expect(screen.getByTestId("group-link-share")).toHaveTextContent("Shared");
    } finally {
      delete (navigator as { share?: unknown }).share;
    }
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    renderApp(<GroupShareDialog group={admin({ entryLink: LINK })} onClose={onClose} />);
    act(() => { screen.getByTestId("group-share-dialog").dispatchEvent(new Event("cancel", { cancelable: true })); });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
