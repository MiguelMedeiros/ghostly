import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { createChatInvite, createIdentity, encodeCommunityLink, encodeGroupEntryLink, groupEntryUrl } from "@ghostly/core";
import { JoinDialog } from "../../components/JoinDialog";
import { renderApp } from "../render";
// covers: invite.invalid, groups.protocol.entry

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

// agents#1631, #1632: a link copied with the sentence around it, pasted in Join.
const group = encodeGroupEntryLink({ g: "AbCdEfGhIjKlMnOpQrStUv", host: createIdentity().pubKeyZ32 });
const groupUrl = groupEntryUrl("https://ghostly.tools", { g: "AbCdEfGhIjKlMnOpQrStUv", host: group.split("/")[2] });
const community = encodeCommunityLink({ g: "AbCdEfGhIjKlMnOpQrStUv", host: createIdentity().pubKeyZ32 });
const { inviteCode } = createChatInvite();

async function paste(value: string) {
  const onJoin = vi.fn();
  const onJoinGroup = vi.fn(async () => {});
  const { user, engine } = renderApp(<JoinDialog onJoin={onJoin} onJoinGroup={onJoinGroup} onClose={() => {}} />);
  engine.readClipboardText = vi.fn(async () => value);
  await user.click(screen.getByRole("button", { name: "Paste from clipboard" }));
  return { onJoin, onJoinGroup, alert: () => screen.queryByRole("alert") };
}

describe("Join reads a link copied with the sentence around it", () => {
  it.each([
    ["a group's link with a full stop", `Join our group: ${groupUrl}.`],
    ["a group's link in parentheses", `(${groupUrl})`],
    ["a group's link before a !", `Join us: ${groupUrl}!`],
    ["a group's link in < >", `<${groupUrl}>`],
    ["a community's link with a full stop", `${community}.`],
  ])("%s joins", async (_, value) => {
    const { onJoinGroup, onJoin, alert } = await paste(value);
    expect(onJoinGroup).toHaveBeenCalledTimes(1);
    expect(onJoin).not.toHaveBeenCalled();
    expect(alert()).toBeNull();
  });

  it.each([
    ["in quotes", `"${inviteCode}"`],
    ["in « »", `« ${inviteCode} »`],
    ["in < >", `Here: <${inviteCode}>.`],
    ["before a ?", `${inviteCode}?`],
    ["in [ ]", `[${inviteCode}]`],
  ])("a chat invite %s joins", async (_, value) => {
    const { onJoin, alert } = await paste(value);
    expect(onJoin).toHaveBeenCalledTimes(1);
    expect(alert()).toBeNull();
  });

  it("a group's link with a character lost is said as a group link that does not work, with what to do", async () => {
    const broken = groupUrl.slice(0, 50) + groupUrl.slice(51);
    const { onJoinGroup, onJoin } = await paste(`Join our group: ${broken}.`);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This link to a group does not work");
    expect(alert).toHaveTextContent("Ask for the link again");
    expect(alert).not.toHaveTextContent("This is not a Ghostly invite.");
    expect(onJoinGroup).not.toHaveBeenCalled();
    expect(onJoin).not.toHaveBeenCalled();
  });
});
