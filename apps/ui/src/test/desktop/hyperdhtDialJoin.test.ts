import { beforeEach, describe, expect, it, vi } from "vitest";

// covers: transport.hyperdht

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), channels: [] as { onmessage: ((event: unknown) => void) | null }[] }));
vi.mock("@tauri-apps/api/core", () => ({
  getIdentifier: async () => "tools.ghostly.app",
  invoke: tauri.invoke,
  convertFileSrc: (path: string) => path,
  Channel: class { onmessage: ((event: unknown) => void) | null = null; constructor() { tauri.channels.push(this); } },
}));

import { createHyperEndpoint } from "../../desktop/nativeTransports";

const contact = { publicKey: "cd".repeat(32) };

/**
 * Rust runs one HyperDHT dial per endpoint and refuses a second while one is pending (`hyperdht.rs`). A chat's own
 * redial is under way when the person chooses HyperDHT (or Automatic): the chosen dial goes to the same contact.
 */
describe("a HyperDHT dial chosen while the app's own dial of that contact is pending", () => {
  let answers: { resolve: (id: number) => void; reject: (error: string) => void }[];
  beforeEach(() => {
    tauri.channels.length = 0;
    tauri.invoke.mockReset();
    answers = [];
    let pending = false;
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === "paired_hyperdht_start") return { id: 1, descriptor: { publicKey: "ab".repeat(32) } };
      if (command !== "paired_hyperdht_connect") return null;
      if (pending) throw "A native connection attempt is already running";
      pending = true;
      return new Promise<number>((resolve, reject) => answers.push({
        resolve: (id) => { pending = false; resolve(id); },
        reject: (error) => { pending = false; reject(error); },
      }));
    });
  });
  const dials = () => tauri.invoke.mock.calls.filter(([command]) => command === "paired_hyperdht_connect").length;

  it("takes that dial's connection once it opens, and Rust is asked once", async () => {
    const endpoint = await createHyperEndpoint("c2VlZA");
    const redial = endpoint.connect(contact).catch((error: Error) => error);
    const chosen = endpoint.connect({ ...contact });
    await Promise.resolve();
    tauri.channels[0].onmessage!({ type: "open", id: 7, binding: { transport: "hyperdht/1" }, incoming: false });
    answers[0].resolve(7);
    const bound = await chosen;
    expect(bound.binding).toEqual({ transport: "hyperdht/1" });
    // The redial was let go for the chosen one: it does not get (and close) the same connection.
    expect(await redial).toBeInstanceOf(Error);
    expect(dials()).toBe(1);
    await endpoint.close();
  });

  it("takes that dial's real failure, not Rust's refusal", async () => {
    const endpoint = await createHyperEndpoint("c2VlZA");
    const redial = endpoint.connect(contact).catch(() => {});
    const chosen = endpoint.connect(contact);
    await Promise.resolve();
    answers[0].reject("peer not found");
    await expect(chosen).rejects.toBe("peer not found");
    await redial;
    // Over: the next dial goes to Rust again.
    const next = endpoint.connect(contact).catch(() => {});
    await vi.waitFor(() => expect(dials()).toBe(2));
    answers[1].reject("peer not found");
    await next;
    await endpoint.close();
  });
});
