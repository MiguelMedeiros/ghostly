import { Profiler } from "react";
import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProfile, prefixOf, registryKey, settingsKeyFor } from "../../lib/profiles";
import { getPrefix, saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { Profile } from "../../pages/Profile";
import { fakeEngine, type StatePatch } from "../fakeEngine";
import { renderApp } from "../render";
import { proofView } from "./views";

// covers: proofs.badges

/**
 * The Profile page shows how many identities and chats the profile has. The engine sends its whole state anew on every
 * change, up to 20 times a second while a file moves: the page draws again only when the count it shows changes, and a
 * draw counts the chats without reading every chat's messages. Nor does another profile's tab, writing its chats a few
 * times per text it gets, draw it again.
 */

const chat = (id: string): ChatSession => ({
  id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: id.repeat(52), encKeyB64: "enc", createdAt: 1,
  messages: Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, text: `message ${i}`, sender: "peer", timestamp: i + 1 })) as ChatSession["messages"],
});
/** The state as the engine sends it after a change elsewhere: the same content, every object new. */
const sentAgain = (patch: StatePatch = {}) => act(() => fakeEngine.setState({ ...structuredClone(fakeEngine.state), ...patch } as StatePatch));

afterEach(() => { vi.restoreAllMocks(); });

describe("the Profile page on an engine state", () => {
  it("is not drawn again when the identities it counts did not change", () => {
    fakeEngine.setState({ identityProofs: [proofView()] });
    let draws = 0;
    renderApp(<Profiler id="profile" onRender={() => { draws++; }}><Profile /></Profiler>);
    expect(screen.getByTestId("profile-identities-link")).toHaveTextContent("1");
    const before = draws;
    for (let i = 0; i < 5; i++) sentAgain({ transfers: { [`file-${i}`]: { state: "transferring", transferred: i * 1000, size: 10_000 } } });
    expect(draws - before).toBe(0);
    sentAgain({ identityProofs: [proofView(), proofView({ id: "b".repeat(64), subject: "other" })] });
    expect(screen.getByTestId("profile-identities-link")).toHaveTextContent("2");
  });

  it("is not drawn again on another profile's tab storing its chats, and is on this profile's keys", () => {
    const work = createProfile("Work");
    let draws = 0;
    renderApp(<Profiler id="profile" onRender={() => { draws++; }}><Profile /></Profiler>);
    const stored = (key: string | null) => act(() => { window.dispatchEvent(new StorageEvent("storage", { key, storageArea: localStorage })); });
    const before = draws;
    // About three writes per text that profile gets, for 30 texts: its chat, its read mark, a draft.
    for (let i = 0; i < 30; i++) for (const key of [`${prefixOf(work.id)}chat${i % 3}`, `${prefixOf(work.id)}read_chat${i % 3}`, `${prefixOf(work.id)}draft_chat${i % 3}`]) stored(key);
    expect(draws - before).toBe(0);
    // The registry, the other profile's settings (its colour in the list), this profile's own keys and a cleared storage do.
    for (const key of [registryKey(), settingsKeyFor(work.id), `${getPrefix()}chat1`, null]) {
      const at = draws;
      stored(key);
      expect(draws - at, String(key)).toBeGreaterThan(0);
    }
  });

  it("counts the chats without parsing each chat's stored copy on every draw", async () => {
    for (const id of ["a", "b", "c", "d"]) saveSession(chat(id));
    const { user } = renderApp(<Profile />);
    expect(screen.getByText(/4 chats/)).toBeInTheDocument();
    const parse = vi.spyOn(JSON, "parse");
    const chatsParsed = () => parse.mock.calls.filter(([text]) => typeof text === "string" && text.includes('"mySeedB64"')).length;
    await user.type(screen.getByTestId("profile-name"), "abc");
    expect(chatsParsed()).toBe(0);
  });
});
