import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { compareVersions, isNewerVersion } from "../src";

// covers: core.version

const part = fc.integer({ min: 0, max: 999_999 });
const version = fc.tuple(part, part, part);
const text = ([a, b, c]: [number, number, number]) => `${a}.${b}.${c}`;

describe("version comparison properties", () => {
  it("agrees with numeric tuple order, both ways round", () => {
    fc.assert(fc.property(version, version, (a, b) => {
      const expected = Math.sign(a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
      expect(Math.sign(compareVersions(text(a), text(b)))).toBe(expected);
      expect(Math.sign(compareVersions(text(b), text(a)))).toBe(-expected);
      expect(isNewerVersion(text(a), text(b))).toBe(expected > 0);
    }), { numRuns: 200 });
  });

  it("never reads arbitrary text as newer than, or older than, a real version", () => {
    fc.assert(fc.property(fc.string({ maxLength: 40 }).filter(s => !/^\s*v?\d{1,6}\.\d{1,6}\.\d{1,6}([-+].*)?\s*$/s.test(s)), version, (junk, v) => {
      expect(compareVersions(junk, text(v))).toBe(0);
      expect(compareVersions(text(v), junk)).toBe(0);
      expect(isNewerVersion(junk, text(v))).toBe(false);
    }), { numRuns: 200 });
  });

  it("refuses a component one digit over the limit", () => {
    expect(isNewerVersion("999999.0.0", "0.0.1")).toBe(true);
    expect(isNewerVersion("1000000.0.0", "0.0.1")).toBe(false);
  });
});
