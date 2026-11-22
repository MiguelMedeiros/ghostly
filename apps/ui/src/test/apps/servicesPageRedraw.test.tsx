import { Profiler } from "react";
import { act, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { Services } from "../../pages/Services";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: services.open

/*
 * The engine sends its whole state anew on every change, up to 20 a second while a file moves, and the Services page
 * stays open while the person uses it. A state that changes nothing the page shows draws none of it, and no draw parses
 * every chat's stored copy (messages and all) for its contacts' names: with 300 chats, 20 such states took about 850 ms.
 */

const chat = (id: string, label?: string): ChatSession => ({
  id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: id.padStart(52, "p"), encKeyB64: "enc", createdAt: 1, ...(label && { label }),
  messages: Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, text: `message ${i}`, sender: "peer", timestamp: i + 1 })) as ChatSession["messages"],
});
const wait = (ms: number) => act(() => new Promise<void>((done) => setTimeout(done, ms)));
const transfers = () => { for (let i = 0; i < 20; i++) act(() => fakeEngine.update({ transfers: { [`t${i}`]: { bytes: i } } } as never)); };

afterEach(() => {
  vi.restoreAllMocks();
  fakeEngine.features = { ...fakeEngine.features, shareLocalServices: false };
});

describe("the Services page on an engine state that changes nothing it shows", () => {
  it("is not drawn again, and parses no chat", async () => {
    for (const id of ["a", "b", "c", "d"]) saveSession(chat(id));
    let draws = 0;
    renderApp(<Profiler id="services" onRender={() => { draws++; }}><Services /></Profiler>, { route: "/services" });
    await wait(50);
    draws = 0;
    const parse = vi.spyOn(JSON, "parse");
    transfers();
    await wait(50);
    expect(draws).toBe(0);
    expect(parse.mock.calls.filter(([text]) => typeof text === "string" && text.includes('"mySeedB64"'))).toHaveLength(0);
  });

  it("still shows a contact's app once they share one, and this device's app once it stops", async () => {
    fakeEngine.features = { ...fakeEngine.features, shareLocalServices: true };
    const ana = chat("ana", "Ana");
    saveSession(ana);
    fakeEngine.update({ services: [{ id: "mine", name: "Notes", target: "localhost:3400", enabled: true, requests: 0, createdAt: 1 }] });
    renderApp(<Services />, { route: "/services" });
    const card = await screen.findByTestId("service-item");
    expect(within(card).getByTestId("service-sharing")).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByTestId("contact-service-open")).toBeNull();

    act(() => fakeEngine.update({
      links: [linkView({ peerPubKeyZ32: ana.peerPubKeyB64, peerServices: [{ id: "album", type: "http", name: "Album" }] })],
      services: [{ id: "mine", name: "Notes", target: "localhost:3400", enabled: false, requests: 0, createdAt: 1 }],
    }));
    expect(await screen.findByTestId("contact-service-open")).toHaveTextContent("Album");
    expect(within(screen.getByTestId("service-item")).getByTestId("service-sharing")).toHaveAttribute("aria-checked", "false");
  });

  it("names a chat added while it is open", async () => {
    fakeEngine.features = { ...fakeEngine.features, shareLocalServices: true };
    fakeEngine.update({ services: [{ id: "mine", name: "Notes", target: "localhost:3400", enabled: true, requests: 0, createdAt: 1 }] });
    const { user } = renderApp(<Services />, { route: "/services" });
    await user.click(await screen.findByTestId("service-people"));
    expect(screen.queryAllByTestId("service-grant")).toHaveLength(0);
    act(() => { saveSession(chat("bo", "Bo")); window.dispatchEvent(new Event("session-updated")); });
    expect(await screen.findByTestId("service-grant")).toHaveTextContent("Bo");
  });
});
