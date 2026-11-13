import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { engine } from "@ghostly/browser/platform/engine";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chats.list.rows

/*
 * Every row of the chat list reads its contact's link (picture, typing, DHT only, identities). Each looked it up with a
 * pass over the whole list of chats, six per row, on every engine state: N rows x N links, ~63 ms a state at 2,000
 * chats while nothing on screen changed. A row finds its contact in an index made once per state.
 */

const N = 200;
const NOW = Date.now();
const key = (i: number) => `p${i}`.padEnd(52, "a");
const chat = (i: number): ChatSession => ({ id: `chat-${i}`, profile: "paired-chat/1", mySeedB64: `seed-${i}`, peerPubKeyB64: key(i),
  encKeyB64: "enc", nick: `Contact ${i}`, createdAt: NOW, lastSyncAt: NOW - 60_000, messages: [{ id: `m-${i}`, text: `hello ${i}`, sender: "peer", timestamp: NOW - 60_000 }] });
const links = () => Array.from({ length: N }, (_, i) => linkView({ id: `link-${i}`, peerPubKeyZ32: key(i), lastSyncAt: NOW - 60_000 }));

/** Counts the items visited by array passes over the engine state's chats or group edges. */
const PASSES = ["find", "findIndex", "findLast", "some", "every", "filter", "map", "forEach", "reduce", "flatMap"] as const;
let visited = 0;
const originals = new Map<string, unknown>();
function countPasses() {
  for (const name of PASSES) {
    const original = (Array.prototype as unknown as Record<string, (...args: unknown[]) => unknown>)[name];
    originals.set(name, original);
    Object.defineProperty(Array.prototype, name, {
      configurable: true, writable: true,
      value: function (this: unknown[], ...args: unknown[]) {
        if (this === engine.state?.links || this === engine.state?.edges) visited += this.length;
        return original.apply(this, args);
      },
    });
  }
}

describe("the chat list on an engine state that changes nothing it shows", () => {
  beforeEach(() => {
    for (let i = 0; i < N; i++) saveSession(chat(i));
    fakeEngine.update({ links: links(), groups: [], groupsLoaded: true });
  });
  afterEach(() => {
    for (const [name, original] of originals) Object.defineProperty(Array.prototype, name, { configurable: true, writable: true, value: original });
    originals.clear();
  });

  it("does not have each row scan the whole list of chats", () => {
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    expect(screen.getAllByTestId("chat-row")).toHaveLength(N);
    countPasses();
    visited = 0;
    const states = 5;
    for (let i = 0; i < states; i++) act(() => fakeEngine.update({ links: links(), transfers: { [`t${i}`]: { bytes: i } } } as never));
    // A few passes over the list per state are linear; one per row is N x N (six per row was ~120,000 here).
    expect(visited / states).toBeLessThan(10 * N);
  });
});
