import { describe, expect, it, vi } from "vitest";
import { callApi, type ApiContext } from "../src/api";
import { ENGINE_METHODS, SINGLE_DEVICE_ANSWERS, SINGLE_DEVICE_REFUSED } from "../src/engineMethods";
import { asCliError, SINGLE_DEVICE } from "../src/errors";
import { error, ghostly, home, ok } from "./support/cli";
// covers: headless.cli, headless.engine-passthrough

/**
 * A CLI profile is on this one device only (WISP 06, `singleDevice`). `ghostly device --help` suggested `service`,
 * `engine deviceRemove` asked for --yes and then refused, `deviceEnrollReady` said `ready`, and the device calls refused
 * in three wordings behind the engine's prefixes (`engine`, exit 1). Now one answer: why, and what to do instead.
 */
const WORDS = "A CLI profile is on this one device only: it cannot be added to another device, moved to one or taken over from one, and the app's Add a device cannot add it. To run it on another machine, back it up here (ghostly profile backup --out <file>), restore it there (ghostly profile restore <file> <name>) and stop using it here";
const refusal = { code: "refused", message: WORDS, details: { reason: "single_device" } };
/** The calls the hunt ran, and the rest that always failed on a CLI profile. */
const REFUSED = [
  "deviceRemove", "deviceEnrollJoin", "deviceHandoffPush", "deviceTakeover",
  "deviceEnrollInvite", "deviceEnrollConfirm", "deviceEnrollRemove", "deviceRename", "deviceNewSecret",
  "deviceHandoffPull", "deviceHandoffAccept", "deviceHandoffSettle", "deviceTurnPeek", "devicePing", "deviceForkDiscard", "deviceRestoreStartOwn",
];

describe("ghostly device", { timeout: 60_000 }, () => {
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

describe("the engine's device calls on a CLI profile", { timeout: 120_000 }, () => {
  it("are refused in one wording (refused, exit 1), deviceRemove before it asks for --yes; deviceEnrollReady says single", async () => {
    const dir = home("single-device");
    ok(await ghostly(["--home", dir, "profile", "create", "bot", "--use"]));
    const engine = (...args: string[]) => ghostly(["--home", dir, "engine", ...args]);
    // Nothing to confirm: the remove can never happen here.
    expect(error(await engine("deviceRemove", JSON.stringify({ key: "AAAA" })), "refused", 1)).toEqual(refusal);
    const calls: [string, Record<string, unknown>][] = [
      ["deviceRemove", { key: "AAAA" }],
      ["deviceEnrollJoin", { code: "ghostly1zexample", name: "CLI" }],
      ["deviceHandoffPush", { key: "AAAA" }],
      ["deviceTakeover", { password: "p", name: "x" }],
    ];
    for (const [method, params] of calls) {
      expect(error(await engine(method, JSON.stringify(params), "--yes"), "refused", 1), method).toEqual(refusal);
    }
    expect(ok(await engine("deviceEnrollReady"))).toBe("single");
  });

  it("over the socket API too, before the engine is asked, the yes or the parameters", async () => {
    const node = Object.fromEntries([...REFUSED, "deviceEnrollReady"].map((method) => [method, vi.fn(async () => "ready")]));
    const ctx = { runtime: { server: { node } }, mode: "daemon" } as unknown as ApiContext;
    for (const method of REFUSED) {
      for (const params of [{ method }, { method, params: { key: "AAAA" } }, { method, params: { key: "AAAA" }, yes: true }]) {
        await expect(callApi(ctx, "engine.call", params), method).rejects.toMatchObject(refusal);
      }
      expect(node[method], method).not.toHaveBeenCalled();
    }
    expect(await callApi(ctx, "engine.call", { method: "deviceEnrollReady" })).toBe("single");
    expect(node.deviceEnrollReady).not.toHaveBeenCalled();
  });

  it("every device call either answers or is refused, and the engine's own refusal reads as the same one", () => {
    expect(SINGLE_DEVICE).toBe(WORDS);
    expect([...SINGLE_DEVICE_REFUSED].sort()).toEqual([...REFUSED].sort());
    const device = ENGINE_METHODS.filter((method) => method.startsWith("device"));
    expect(device.filter((method) => !SINGLE_DEVICE_REFUSED.has(method) && !SINGLE_DEVICE_ANSWERS.has(method))).toEqual([]);
    expect([...SINGLE_DEVICE_REFUSED].filter((method) => SINGLE_DEVICE_ANSWERS.has(method))).toEqual([]);
    for (const said of ["enroll-single: A profile of the command line is on one device only", "remove-state: A profile of the command line is on one device only", "rename-state: A profile of the command line is on one device only", "A profile of the command line is on one device only"]) {
      expect(asCliError(new Error(said)).toJSON(), said).toEqual(refusal);
    }
  });
});
