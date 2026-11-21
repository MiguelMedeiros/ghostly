import type { LinkView } from "@ghostly/browser/shared/types";
import { describe, expect, it } from "vitest";
import { chatDetailsJson, chatJson } from "../src/views";

const link = (fields: Partial<LinkView> = {}) => ({ id: "c", peerPubKeyZ32: "pc", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "dht", deliveryMode: "dht", ...fields }) as unknown as LinkView;
const REFUSED = "Could not publish DHT delivery: Publish failed on every relay: Error: http://127.0.0.1:58894 responded 503";

describe("a chat's connection error", () => {
  it("a DHT-only chat whose relays refuse its publishes says so in chat show and chat list", () => {
    // What the engine has once the relay refuses (agents#3565): the pairing and the DHT delivery both name it.
    const chat = link({ pairing: { status: "error", error: REFUSED }, dhtDelivery: { error: REFUSED, mode: "dht" }, transportErrors: { "iroh/1": "Iroh relay unreachable" } } as Partial<LinkView>);
    const said = "Could not publish DHT delivery: no relay took it (127.0.0.1:58894)";
    expect(chatJson(chat)).toMatchObject({ pairing: "error", connectionError: said });
    expect(chatDetailsJson(chat)).toMatchObject({ pairing: "error", connectionError: said });
  });

  it("names the relays that did not answer, and keeps other words as they are", () => {
    const silent = "Could not publish DHT delivery: Publish failed on every relay: Error: http://a.example:8080 did not answer a moment ago; retry shortly; Error: https://b.example/ timed out";
    expect(chatJson(link({ dhtDelivery: { error: silent, mode: "dht" } } as Partial<LinkView>)).connectionError).toBe("Could not publish DHT delivery: no relay answered (a.example:8080, b.example)");
    expect(chatJson(link({ pairing: { status: "error", error: "Key mismatch" } } as Partial<LinkView>)).connectionError).toBe("Key mismatch");
  });

  it("is the pairing's failure first, as the app's connection panel says it", () => {
    const chat = link({ pairing: { status: "connecting", transitionError: "Could not switch to iroh/1" }, dhtDelivery: { error: REFUSED } } as Partial<LinkView>);
    expect(chatJson(chat).connectionError).toBe("Could not switch to iroh/1");
  });

  it("is null when nothing failed, and a DHT error only counts on a chat whose text goes by the DHT", () => {
    expect(chatJson(link({ pairing: { status: "ready" } } as Partial<LinkView>)).connectionError).toBeNull();
    const live = link({ textDelivery: "stream", deliveryMode: "stream", pairing: { status: "ready" }, dhtDelivery: { error: REFUSED } } as Partial<LinkView>);
    expect(chatJson(live).connectionError).toBeNull();
    // The pairing's own error is not that of a ready pairing: only `error` carries one.
    expect(chatJson(link({ pairing: { status: "waiting", error: "stale" } } as Partial<LinkView>)).connectionError).toBeNull();
  });
});
