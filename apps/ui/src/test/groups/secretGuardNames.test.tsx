import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GroupMemberView, GroupView } from "@ghostly/browser/shared/types";
import { GroupMembersDialog } from "../../components/GroupMembersDialog";
import { NewGroupDialog } from "../../components/NewGroupDialog";
import { StatusPickerHost } from "../../components/StatusPicker";
import { openStatusPicker } from "../../lib/ownStatus";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: groups.rename, groups.create, chat.status.picker

/*
 * A status, a group's new name and a new group's name reach every contact or member: text that looks like a secret
 * asks first there too, as the chat composer does (SecretGuardDialog), and goes only on "Send anyway".
 */

/** Key 0x0101…01: it has never held anything. */
const NSEC = "nsec1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqstywftw";
/** A compressed WIF of key 0x0101…01: 52 characters, a status takes 60. */
const WIF = "KwFfNUhSDaASSAwtG7ssQM1uVX8RgX5GHWnnLfhfiQDigjioWXHH";

const ME = "me".padEnd(52, "y");
const admin = (patch: Partial<GroupView> = {}) => groupView({ status: "active", epoch: 2, isAdmin: true, members: [{ key: ME, role: "admin", me: true, online: true, missing: 0 } as GroupMemberView], ...patch });
const guard = () => screen.queryByTestId("secret-guard");

describe("the secret guard on names and the status", () => {
  it("a group renamed to a Nostr key asks first: Cancel keeps it here, Send anyway renames", async () => {
    fakeEngine.update({ groups: [admin({ name: "Friends" })] });
    const { user, engine } = renderApp(<GroupMembersDialog group={admin({ name: "Friends" })} onClose={() => {}} />);
    engine.on("renameGroup", () => undefined);
    await user.click(screen.getByTestId("group-rename"));
    const input = screen.getByTestId("group-rename-input");
    await user.clear(input);
    await user.click(input);
    await user.paste(NSEC);
    await user.click(screen.getByTestId("group-rename-save"));
    expect(await screen.findByTestId("secret-guard")).toHaveAttribute("data-kind", "nsec");
    expect(engine.callsTo("renameGroup")).toEqual([]);
    await user.click(screen.getByTestId("secret-guard-cancel"));
    expect(guard()).not.toBeInTheDocument();
    expect(engine.callsTo("renameGroup")).toEqual([]);
    expect(screen.getByTestId("group-rename-input")).toHaveValue(NSEC);
    await user.click(screen.getByTestId("group-rename-save"));
    await user.click(await screen.findByTestId("secret-guard-send"));
    await waitFor(() => expect(engine.callsTo("renameGroup")).toEqual([{ groupId: "group-1", name: NSEC }]));
  });

  it("a new group named with a Nostr key asks before it is made", async () => {
    const { user, engine } = renderApp(<NewGroupDialog onClose={() => {}} onCreated={() => {}} />);
    engine.on("createGroup", () => ({ groupId: "g" }));
    engine.on("enableGroupLink", () => ({ link: "" }));
    await user.click(screen.getByTestId("new-group-name"));
    await user.paste(NSEC);
    await user.click(screen.getByTestId("new-group-create"));
    expect(await screen.findByTestId("secret-guard")).toHaveAttribute("data-kind", "nsec");
    expect(engine.callsTo("createGroup")).toEqual([]);
    await user.click(screen.getByTestId("secret-guard-cancel"));
    expect(engine.callsTo("createGroup")).toEqual([]);
    // A name that is no secret is made at once.
    await user.clear(screen.getByTestId("new-group-name"));
    await user.type(screen.getByTestId("new-group-name"), "Book club");
    await user.click(screen.getByTestId("new-group-create"));
    await waitFor(() => expect(engine.callsTo("createGroup")).toEqual([{ name: "Book club", profile: "community" }]));
    expect(guard()).not.toBeInTheDocument();
  });

  it("a status of a Bitcoin private key asks first, and is set only on Send anyway", async () => {
    fakeEngine.on("getOwnStatus", () => ({ sharePresence: true }));
    const { user, engine } = renderApp(<StatusPickerHost />);
    engine.on("setOwnStatus", () => undefined);
    act(() => openStatusPicker());
    const dialog = await screen.findByRole("dialog", { name: "Status" });
    await user.click(within(dialog).getByRole("textbox", { name: "Status text" }));
    await user.paste(WIF);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByTestId("secret-guard")).toHaveAttribute("data-kind", "bitcoin-key");
    expect(engine.callsTo("setOwnStatus")).toEqual([]);
    await user.click(screen.getByTestId("secret-guard-cancel"));
    expect(engine.callsTo("setOwnStatus")).toEqual([]);
    expect(screen.getByRole("dialog", { name: "Status" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await user.click(await screen.findByTestId("secret-guard-send"));
    await waitFor(() => expect(engine.callsTo("setOwnStatus")).toHaveLength(1));
    expect(engine.callsTo("setOwnStatus")[0]).toMatchObject({ status: { text: WIF } });
  });
});
