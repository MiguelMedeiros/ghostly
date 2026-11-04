import { describe, expect, it } from "vitest";
import { jsonOut } from "../src/jsonOut";
import { ghostly } from "./support/cli";
// covers: headless.cli

/** A text with what a terminal acts on past `JSON.stringify`'s own escapes: CSI, OSC, ST, NEL, RLO, DEL, LS, isolates. */
const TEXT = "A\u009b2JB\u009d0;title\u009cC\u0085D\u202eE\u007fF\u2028G\u2066H\u2069I\u200fJ\u061cK";
/** No C1 control, DEL, line or paragraph separator, nor a bidi control raw. */
const RAW = /[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

describe("what the CLI prints", () => {
  it("writes the controls a terminal acts on as \\uXXXX, the same JSON value for every reader", () => {
    const value = { text: TEXT, nested: [{ name: TEXT }], kept: "olá 👋🏽 مرحبا \u{1F469}\u200d\u{1F4BB} a\u200cb" };
    for (const space of [undefined, 2]) {
      const out = jsonOut(value, space);
      expect(out).not.toMatch(RAW);
      expect(out).toContain("A\\u009b2JB\\u009d0;title\\u009cC\\u0085D\\u202eE\\u007fF\\u2028G\\u2066H\\u2069I\\u200fJ\\u061cK");
      expect(JSON.parse(out)).toEqual(value);
    }
    // Text with none of them is printed as JSON.stringify prints it: emoji, joiners, accents and Arabic stay raw.
    expect(jsonOut(value.kept)).toBe(JSON.stringify(value.kept));
    expect(jsonOut(undefined)).toBeUndefined();
  });

  it("an answer of the built CLI holds none of them raw", async () => {
    // A failure's answer repeats the command asked: the shortest way to a peer-shaped string on stdout.
    const result = await ghostly([`x${TEXT}`]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("\\u009b2J");
    expect(result.stdout).not.toMatch(RAW);
    expect(JSON.stringify(result.json)).toContain(TEXT);
  });
});
