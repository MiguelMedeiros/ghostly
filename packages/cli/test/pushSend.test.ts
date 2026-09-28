import { describe, expect, it } from "vitest";
import { addressBytes, isPublicIp, nodePushSend, publicOnly, publicOnlyLookup } from "../src/runtime/pushSend";

// covers: push.wake.send

const push = (url: string) => ({ url, headers: { Authorization: "vapid t=a.b.c, k=K", TTL: "60" }, body: new Uint8Array(4) });

describe("the CLI's wake-up push (WISP 401 § Wake-up push)", () => {
  it("reads addresses as bytes", () => {
    expect([...addressBytes("10.1.2.3")!]).toEqual([10, 1, 2, 3]);
    expect(addressBytes("::1")![15]).toBe(1);
    expect([...addressBytes("::ffff:127.0.0.1")!.subarray(10)]).toEqual([0xff, 0xff, 127, 0, 0, 1]);
    expect(addressBytes("2001:db8::1")![0]).toBe(0x20);
    expect(addressBytes("fcm.googleapis.com")).toBeNull();
  });

  it.each(["127.0.0.1", "10.0.0.8", "192.168.1.1", "169.254.169.254", "100.81.12.32", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1", "0.0.0.0"])("%s is not public", (address) => {
    expect(isPublicIp(address)).toBe(false);
  });

  it.each(["142.250.64.74", "2607:f8b0:4004:c1b::5f"])("%s is public", (address) => {
    expect(isPublicIp(address)).toBe(true);
  });

  it("posts to push services only", async () => {
    for (const url of ["https://push.example.com/x", "https://127.0.0.1.nip.io/x", "https://fcm.googleapis.com:8443/x", "http://fcm.googleapis.com/x"]) {
      await expect(nodePushSend(push(url))).rejects.toThrow();
    }
  });

  it("refuses a name that resolves to a local address", async () => {
    const error = await new Promise<Error | null>((resolve) => publicOnlyLookup("localhost", {}, (e) => resolve(e)));
    expect(error?.message).toMatch(/not a public address/);
  });

  it("does not connect when the push service's name resolves to a private address", async () => {
    // What a poisoned or rebinding resolver answers for a push service's name.
    const lying = publicOnly((_host, _options, callback) => callback(null, [{ address: "142.250.64.74", family: 4 }, { address: "127.0.0.1", family: 4 }]));
    await expect(nodePushSend(push("https://fcm.googleapis.com/fcm/send/x"), lying)).rejects.toThrow(/not a public address/);
  });
});
