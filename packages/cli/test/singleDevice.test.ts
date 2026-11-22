import { describe, expect, it } from "vitest";
import { SINGLE_DEVICE } from "../src/errors";
import { error, ghostly } from "./support/cli";
// covers: headless.cli

/**
 * A CLI profile is on this one device only (WISP 06, `singleDevice`). `ghostly device --help` suggested `service`.
 * Now `ghostly device` says why, and what to do instead.
 */
const WORDS = "A CLI profile is on this one device only: it cannot be added to another device, moved to one or taken over from one, and the app's Add a device cannot add it. To run it on another machine, back it up here (ghostly profile backup --out <file>), restore it there (ghostly profile restore <file> <name>) and stop using it here";

describe("ghostly device", { timeout: 60_000 }, () => {
  it("its words are the ones the CLI keeps", () => {
    expect(SINGLE_DEVICE).toBe(WORDS);
  });

  it("help says a CLI profile is on this one device only, and how to run it on another machine (exit 0)", async () => {
    for (const args of [["device", "--help"], ["help", "device"], ["device", "list", "--help"]]) {
      const { code, stdout } = await ghostly(args);
      expect(code, args.join(" ")).toBe(0);
      expect(stdout, args.join(" ")).toContain("Usage: ghostly device");
      expect(stdout, args.join(" ")).toContain(WORDS);
      expect(stdout, args.join(" ")).not.toContain("service");
    }
  });

  it("run, it is a usage error (exit 2) saying the same, not a suggestion of another command", async () => {
    for (const args of [["device"], ["device", "list"], ["device", "add", "laptop"]]) {
      const failure = error(await ghostly(args), "usage", 2);
      expect(failure.message, args.join(" ")).toBe(`${WORDS} (ghostly help device)`);
    }
  });
});
