import { describe, expect, it } from "vitest";
import { nodeHoldFetch } from "../src/runtime/holdFetch";
import { publicOnly } from "../src/runtime/pushSend";

// covers: delivery.hold.protocol

describe("the CLI's held-item reads (WISP 404)", () => {
  it("does not connect when the storage's name resolves to this machine", async () => {
    await expect(nodeHoldFetch()("https://localhost/b/o")).rejects.toThrow(/not a public address/);
  });

  it("does not connect when the storage's name resolves to a private address, even among public ones", async () => {
    // What a name the contact set up to point into this device's network answers.
    const lying = publicOnly((_host, _options, callback) => callback(null, [{ address: "142.250.64.74", family: 4 }, { address: "192.168.1.1", family: 4 }]));
    await expect(nodeHoldFetch(lying)("https://s3.example.com/b/o")).rejects.toThrow(/not a public address/);
    const intranet = publicOnly((_host, _options, callback) => callback(null, [{ address: "10.0.0.5", family: 4 }]));
    await expect(nodeHoldFetch(intranet)(new URL("https://storage.example.com/b/o"))).rejects.toThrow(/not a public address/);
  });
});
