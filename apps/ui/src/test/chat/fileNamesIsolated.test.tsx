// happy-dom has no IndexedDB: the file store keeps what is sent in this one.
import "fake-indexeddb/auto";
import { fireEvent, screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupMemberView } from "@ghostly/browser/shared/types";
import { AudioBubble } from "../../components/audio/AudioBubble";
import { FileBubble } from "../../components/FileBubble";
import { VideoBubble } from "../../components/video/VideoBubble";
import { fileStatus } from "../../lib/fileStatus";
import { servicesPlatform, type FileTransferState } from "../../lib/platform";
import type { ChatFile } from "../../lib/types";
import { englishT, translateWith } from "../../locales/translate";
import { LOCALES as locales } from "../i18n/locales";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { everythingOnScreen } from "../onScreen";
import { renderApp } from "../render";

// covers: app.i18n

/*
 * A contact's and a file's name in a file's lines, in a language of the other direction: each isolated, as the Apps
 * lines' names are. Put in plainly, the punctuation at a name's end took the sentence's direction and was drawn on the
 * other side: "يريد !Bob إرسال" in Arabic; and an Arabic file's name ending in a number had it jump in English.
 */

const MB = 1024 ** 2;
const asking: FileTransferState = { state: "transferring", stage: "asking", direction: "in", transferred: 0, size: 40 * MB, room: 12 * 1024 * MB };
const file = (patch: Partial<ChatFile> = {}): ChatFile => ({ id: "chat1-in-abc", name: "Club!", size: 40 * MB, mime: "application/zip", ...patch });
/** The name between FSI and PDI, as a string with no room for a <bdi> holds it. */
const iso = (name: string) => `⁨${name}⁩`;
/** The <bdi>s holding exactly this name inside the element. */
const isolated = (el: HTMLElement, name: string) => [...el.querySelectorAll("bdi")].filter(bdi => bdi.textContent === name).length;

beforeEach(() => {
  everythingOnScreen();
  vi.spyOn(servicesPlatform!, "getFile").mockResolvedValue(null);
  fakeEngine.on("fileAction", () => undefined);
});

describe("names in a file's lines, each isolated", () => {
  it.each([
    ["ar", "Bob!", "Club!"],
    ["en", "Ana", "تقرير 2"],
  ] as const)("an offer names the contact and the file isolated (%s)", (language, peer, name) => {
    const f = file({ name });
    fakeEngine.update({ links: [linkView({ id: "chat1" })], transfers: { [f.id]: asking } });
    renderApp(<FileBubble file={f} peerName={peer} />, { language });
    const offer = screen.getByTestId("file-offer");
    expect(isolated(offer, peer)).toBe(1);
    expect(isolated(offer, name)).toBe(1);
  });

  it.each([
    ["video", (f: ChatFile) => <VideoBubble file={f} sender="peer" peerName="Bob!" />, "video-room"],
    ["audio", (f: ChatFile) => <AudioBubble file={f} sender="peer" peerName="Bob!" />, "audio-room"],
  ] as const)("the %s bubble's offer names the contact isolated", (_, bubble, testId) => {
    const f = file({ id: "chat1-in-media", name: "clip.mp4", mime: _ === "video" ? "video/mp4" : "audio/mpeg" });
    fakeEngine.update({ links: [linkView({ id: "chat1" })], transfers: { [f.id]: asking } });
    renderApp(bubble(f), { language: "ar" });
    expect(isolated(screen.getByTestId(testId), "Bob!")).toBe(1);
  });

  it("the line under a file names the contact isolated", () => {
    const t = translateWith(locales.ar, "ar");
    const sent = (patch: Partial<FileTransferState>) => fileStatus(file(), { state: "transferring", direction: "out", transferred: 0, size: 40 * MB, ...patch }, "Bob!", false, t);
    for (const stage of ["asking", "queued", "verifying"] as const) expect(sent({ stage }), stage).toContain(iso("Bob!"));
    expect(sent({ stage: "paused", pausedBy: "peer" })).toContain(iso("Bob!"));
    // A contact with no name: the app's own words, as they were.
    expect(fileStatus(file(), { state: "transferring", stage: "asking", direction: "out", transferred: 0, size: 40 * MB }, undefined, false, englishT)).toBe("Waiting for your contact to accept · 40.0 MB");
  });

  it("the composer's line names a file being prepared isolated", async () => {
    const ME = "me".padEnd(52, "y");
    const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
    fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined).on("sendGroupFile", () => new Promise(() => {}));
    fakeEngine.update({ groups: [groupView({ status: "active", epoch: 1, members: [member({ key: ME, me: true }), member({ key: "bob".padEnd(52, "y"), nick: "Bob" })] })] });
    renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1", language: "ar" });
    fireEvent.change(await screen.findByTestId("file-input"), { target: { files: [new File(["a large file"], "Club!.zip", { type: "application/zip" })] } });
    expect(isolated(await screen.findByTestId("file-preparing"), "Club!.zip")).toBe(1);
  });
});
