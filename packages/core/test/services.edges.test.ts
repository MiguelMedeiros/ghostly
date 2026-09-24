import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { MAX_SERVICES, decodeServices, encodeServices, isValidServiceId, serviceIdFromName, servicesFromWire, servicesToWire, type ServiceAd } from "../src/services";

describe("service advertisements from a peer", () => {
  it("refuses advertisements that are not JSON objects with a version and a list", () => {
    for (const json of ["{", "null", "5", '"s"', '{"s":[]}', '{"v":"1","s":[]}', '{"v":0,"s":[]}', '{"v":1}', '{"v":1,"s":{}}']) {
      expect(decodeServices(json)).toBeNull();
    }
    expect(servicesFromWire(undefined)).toBeNull();
  });

  it("accepts a newer version and keeps what it understands", () => {
    expect(decodeServices(JSON.stringify({ v: 2, s: ["chat", { i: "x", t: "future-thing", z: 1 }] }))).toEqual([{ id: "chat", type: "chat" }, { id: "x", type: "future-thing" }]);
  });

  it("drops entries with a missing, malformed or duplicate id or type", () => {
    const s = [
      { i: "ok", t: "http" }, { i: "ok", t: "chat" }, { t: "http" }, { i: "no-type" }, { i: 5, t: "http" }, { i: "x", t: 5 },
      { i: "-lead", t: "http" }, { i: "UPPER", t: "http" }, { i: "a".repeat(33), t: "http" }, { i: "t", t: "Bad Type" }, null, [], "",
    ];
    expect(decodeServices(JSON.stringify({ v: 1, s }))).toEqual([{ id: "ok", type: "http" }]);
  });

  it("reads at most sixteen entries, even when later ones are valid", () => {
    const s = [...new Array(MAX_SERVICES).fill(5), "chat"];
    expect(decodeServices(JSON.stringify({ v: 1, s }))).toEqual([]);
    const many = Array.from({ length: MAX_SERVICES + 4 }, (_, i) => `s${i}`);
    expect(decodeServices(JSON.stringify({ v: 1, s: many }))).toHaveLength(MAX_SERVICES);
  });

  it("sanitizes names and protocols, keeps at most eight metadata entries, and drops non-string metadata", () => {
    const m: Record<string, unknown> = { a: "1", b: 2, "\u202e": "hidden key", c: "\u200b", d: "4" };
    for (let i = 0; i < 10; i++) m[`k${i}`] = "v";
    const [ad] = decodeServices(JSON.stringify({ v: 1, s: [{ i: "app", t: "http", n: "\u202eAtlas" + "x".repeat(100), p: 7, m }] }))!;
    expect(ad.name).toBe("Atlas" + "x".repeat(43));
    expect(ad).not.toHaveProperty("proto");
    expect(ad.meta).toEqual({ a: "1", d: "4", k0: "v", k1: "v", k2: "v" });
  });

  it("leaves out metadata that is not an object or has nothing usable, and a name with nothing visible", () => {
    const decoded = decodeServices(JSON.stringify({ v: 1, s: [{ i: "a", t: "http", m: "x", n: "\u200b" }, { i: "b", t: "http", m: { k: 1 } }] }))!;
    expect(decoded).toEqual([{ id: "a", type: "http" }, { id: "b", type: "http" }]);
  });

  it("never throws on arbitrary JSON, and everything it returns has a valid id", () => {
    fc.assert(fc.property(fc.jsonValue(), wire => {
      const out = servicesFromWire({ v: 1, s: Array.isArray(wire) ? wire : [wire] });
      expect(out!.every(s => isValidServiceId(s.id) && isValidServiceId(s.type))).toBe(true);
      expect(new Set(out!.map(s => s.id)).size).toBe(out!.length);
    }), { numRuns: 200 });
  });
});

describe("service advertisement encoding", () => {
  it("writes a bare id only when nothing else is set, and omits empty metadata", () => {
    const services: ServiceAd[] = [{ id: "chat", type: "chat" }, { id: "chat2", type: "chat" }, { id: "http", type: "http", meta: {} }, { id: "web", type: "http", meta: { k: "v" } }];
    expect(servicesToWire(services).s).toEqual(["chat", { i: "chat2", t: "chat" }, { i: "http", t: "http" }, { i: "web", t: "http", m: { k: "v" } }]);
    expect(decodeServices(encodeServices(services))).toEqual([services[0], services[1], { id: "http", type: "http" }, services[3]]);
  });

  it("round-trips valid advertisements", () => {
    const id = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,31}$/);
    const text = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ]{0,30}[A-Za-z0-9]$/);
    const ad = fc.record({ id, type: id, name: fc.option(text, { nil: undefined }), proto: fc.option(text, { nil: undefined }) }, { requiredKeys: ["id", "type"] });
    fc.assert(fc.property(fc.uniqueArray(ad, { selector: a => a.id, maxLength: MAX_SERVICES }), services => {
      const clean = services.map(s => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) as unknown as ServiceAd);
      expect(decodeServices(encodeServices(clean))).toEqual(clean);
    }), { numRuns: 100 });
  });
});

describe("service ids from names", () => {
  it("never reuses a built-in id or a taken one", () => {
    expect(serviceIdFromName("Chat")).toBe("chat-2");
    expect(serviceIdFromName("Atlas", ["atlas", "atlas-2"])).toBe("atlas-3");
    expect(serviceIdFromName("!!!")).toBe("service");
    expect(serviceIdFromName("  Hello, World!  ")).toBe("hello-world");
    expect(serviceIdFromName("x".repeat(40))).toBe("x".repeat(24));
  });

  it("always yields a valid id", () => {
    fc.assert(fc.property(fc.string({ maxLength: 60 }), fc.array(fc.string({ maxLength: 10 }), { maxLength: 5 }), (name, taken) => {
      const id = serviceIdFromName(name, taken);
      expect(isValidServiceId(id)).toBe(true);
      expect(taken).not.toContain(id);
    }), { numRuns: 200 });
  });
});
