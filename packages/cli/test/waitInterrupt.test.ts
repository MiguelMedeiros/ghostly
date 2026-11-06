import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { profilePaths } from "../src/profiles";
import { waitNotice } from "../src/waitNotice";
import { ghostly, home, ok, Running } from "./support/cli";
// covers: headless.cli

/**
 * A command that waits (`send --wait`, `chat wait`, `file wait`) and Ctrl-C (agents#2354). On a terminal it says on
 * stderr what it waits for; on a pipe nothing. Ctrl-C ends it with one line saying what became of what it waited on,
 * the `interrupted` error and exit 130, a one-shot's profile closed first. It used to show nothing for up to 300 s,
 * end on Ctrl-C with no word, and leave the one-shot's `daemon.lock` behind.
 */
describe("a wait on a terminal, and Ctrl-C", { timeout: 120_000 }, () => {
  const dir = home("wait-interrupt");
  const paths = profilePaths(dir, "default");
  // stderr taken for a terminal's: the CLI reads `process.stderr.isTTY`, which a test's pipe never is.
  const tty = join(dir, "tty-stderr.cjs");
  const onTty = { NODE_OPTIONS: `--require "${tty}"` };
  const running: Running[] = [];
  const start = (args: string[], env: NodeJS.ProcessEnv = {}) => { const r = new Running(["--home", dir, ...args], env); running.push(r); return r; };
  const said = async (r: Running, text: string, ms = 30_000) => {
    const until = Date.now() + ms;
    while (!r.stderr.includes(text)) {
      if (r.child.exitCode !== null || Date.now() > until) throw new Error(`not said: ${text}\nstderr: ${r.stderr}\nstdout: ${JSON.stringify(r.lines)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const lockFiles = () => readdirSync(paths.dir).filter((name) => name.startsWith("daemon.lock"));

  beforeAll(async () => {
    writeFileSync(tty, "Object.defineProperty(process.stderr, \"isTTY\", { value: true });\n");
    // A chat whose contact never comes: an invite nobody joins.
    ok(await ghostly(["--home", dir, "invite", "create", "--label", "solo"]));
  }, 60_000);
  afterAll(async () => { await Promise.all(running.map((r) => r.stop())); });

  it("a one-shot chat wait says what it waits for; Ctrl-C ends it with a line, exit 130 and its profile released", async () => {
    const wait = start(["chat", "wait", "solo", "--until", "paired", "--timeout", "60"], onTty);
    await said(wait, "ghostly: waiting for chat solo to be paired (up to 60 s; Ctrl-C stops waiting)\n");
    expect(lockFiles()).toContain("daemon.lock");
    wait.child.kill("SIGINT");
    expect(await wait.exited(15_000)).toBe(130);
    expect(wait.stderr).toContain("ghostly: stopped waiting (Ctrl-C): chat solo was not paired yet\n");
    expect(wait.lines).toEqual([{ error: { code: "interrupted", message: "Stopped waiting (Ctrl-C): chat solo was not paired yet", details: { method: "chat.wait" } } }]);
    // Released as `daemon` releases it: no lock, no start mark.
    expect(lockFiles()).toEqual([]);
  });

  it("on a pipe it says nothing while it waits; a one-shot send stopped with Ctrl-C says the message still goes, and it does", async () => {
    const send = start(["send", "solo", "kept on Ctrl-C", "--wait", "delivered", "--timeout", "60"]);
    // Well past the moment a terminal is told (WAIT_NOTICE_MS), with the profile open.
    const until = Date.now() + 20_000;
    while (!lockFiles().includes("daemon.lock") && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(send.child.exitCode).toBeNull();
    expect(send.stderr).not.toContain("waiting for");
    send.child.kill("SIGINT");
    expect(await send.exited(15_000)).toBe(130);
    expect(send.stderr).toContain("ghostly: stopped waiting (Ctrl-C): it is kept here and goes with this profile's next command, or keep it online with `ghostly daemon --detach`\n");
    expect((send.lines[0]?.error as { code?: string } | undefined)?.code).toBe("interrupted");
    expect(lockFiles()).toEqual([]);
    const history = ok(await ghostly(["--home", dir, "chat", "history", "solo"])) as { messages: { text: string }[] };
    expect(history.messages.map((m) => m.text)).toContain("kept on Ctrl-C");
  });

  it("a one-shot that waits by default, with no --wait (file send), says so too; Ctrl-C says the file still goes", async () => {
    const path = join(dir, "notes.txt");
    writeFileSync(path, "kept on Ctrl-C\n");
    const send = start(["file", "send", "solo", path], onTty);
    await said(send, "ghostly: waiting for it to go out to solo (up to 300 s; Ctrl-C stops waiting, it still goes)\n");
    send.child.kill("SIGINT");
    expect(await send.exited(15_000)).toBe(130);
    expect(send.stderr).toContain("ghostly: stopped waiting (Ctrl-C): it is kept here and goes with this profile's next command, or keep it online with `ghostly daemon --detach`\n");
    expect(lockFiles()).toEqual([]);
  });

  it("through a daemon, Ctrl-C ends the command (exit 130) and the daemon runs on; the daemon's own Ctrl-C still stops it, exit 0", async () => {
    const daemon = start(["daemon"]);
    await daemon.waitFor((line) => line.daemon === "ready");
    const send = start(["send", "solo", "through the daemon", "--wait", "delivered", "--timeout", "60"], onTty);
    await said(send, "ghostly: waiting for solo's app to confirm it (up to 60 s; Ctrl-C stops waiting, it still goes)\n");
    send.child.kill("SIGINT");
    expect(await send.exited(15_000)).toBe(130);
    expect(send.stderr).toContain("ghostly: stopped waiting (Ctrl-C): it is kept here and still goes by itself while this profile is online\n");
    expect(ok(await ghostly(["--home", dir, "daemon", "status"])).running).toBe(true);
    daemon.child.kill("SIGINT");
    expect(await daemon.exited(30_000)).toBe(0);
    expect(existsSync(paths.lock)).toBe(false);
  });
});

describe("what a wait says", () => {
  it("names what each kind waits for, and what Ctrl-C leaves", () => {
    expect(waitNotice("chat.send", { chat: "bob", wait: "none" }, "daemon")).toBeNull();
    expect(waitNotice("chat.list", {}, "one-shot")).toBeNull();
    expect(waitNotice("chat.send", { chat: "bob", wait: "sent" }, "one-shot")?.waiting).toBe("waiting for it to go out to bob (up to 30 s; Ctrl-C stops waiting, it still goes)");
    expect(waitNotice("group.send", { group: "crew", wait: "sent", timeout: 5 }, "daemon")?.waiting).toBe("waiting for a member's edge in group crew to take it (up to 5 s; Ctrl-C stops waiting, it still goes)");
    expect(waitNotice("chat.forward", { chat: "bob", to: ["ann", "cy"], wait: "sent" }, "daemon")?.waiting).toBe("waiting for it to go out to ann, cy (up to 30 s; Ctrl-C stops waiting, it still goes)");
    expect(waitNotice("file.wait", { file: "f1" }, "daemon")).toEqual({
      waiting: "waiting for file f1's transfer to end (up to 300 s; Ctrl-C stops waiting; the transfer goes on while this profile is online)",
      stopped: "file f1's transfer goes on while this profile is online",
    });
    expect(waitNotice("file.save", { file: "f1", wait: true, timeout: 9 }, "one-shot")?.waiting).toContain("up to 9 s");
  });

  it("names a chat's state in words that read: --until text is a chat that can carry text", () => {
    // It read "waiting for chat bob to be text", and Ctrl-C "chat bob was not text yet".
    expect(waitNotice("chat.wait", { chat: "bob", until: "text" }, "daemon")).toEqual({
      waiting: "waiting for chat bob to carry text (up to 60 s; Ctrl-C stops waiting)",
      stopped: "chat bob could not carry text yet",
    });
    expect(waitNotice("chat.wait", { chat: "bob" }, "daemon")).toEqual({ waiting: "waiting for chat bob to be live (up to 60 s; Ctrl-C stops waiting)", stopped: "chat bob was not live yet" });
    expect(waitNotice("chat.wait", { chat: "bob", until: "paired" }, "daemon")?.stopped).toBe("chat bob was not paired yet");
  });

  it("knows the waits a one-shot does by default, with no --wait, and that a daemon answers those at once", () => {
    expect(waitNotice("file.send", { chat: "bob", path: "/f" }, "one-shot")?.waiting).toBe("waiting for it to go out to bob (up to 300 s; Ctrl-C stops waiting, it still goes)");
    expect(waitNotice("chat.react", { chat: "bob", message: "m", emoji: "👍" }, "one-shot")?.waiting).toBe("waiting for bob's app to confirm it (up to 30 s; Ctrl-C stops waiting, it still goes)");
    expect(waitNotice("chat.pin", { chat: "bob", message: "m", timeout: 5 }, "one-shot")?.waiting).toBe("waiting for bob's app to confirm it (up to 5 s; Ctrl-C stops waiting, it still goes)");
    expect(waitNotice("group.react", { group: "crew", message: "m", emoji: "👍" }, "one-shot")?.waiting).toBe("waiting for a member's edge in group crew to take it (up to 30 s; Ctrl-C stops waiting, it still goes)");
    expect(waitNotice("chat.delete", { chat: "bob", message: "m", everyone: true }, "one-shot")).not.toBeNull();
    expect(waitNotice("chat.pin", { chat: "group:crew", message: "m" }, "one-shot")?.waiting).toBe("waiting for a member's edge in group crew to take it (up to 30 s; Ctrl-C stops waiting, it still goes)");
    expect(waitNotice("file.send", { chat: "group:crew", path: "/f" }, "one-shot")).toBeNull();
    expect(waitNotice("task.send", { chat: "bob", title: "t" }, "one-shot")).not.toBeNull();
    // Asked not to wait, or through a daemon (it answers at once), or a call that never waits: nothing.
    expect(waitNotice("file.send", { chat: "bob", path: "/f", wait: "none" }, "one-shot")).toBeNull();
    expect(waitNotice("file.send", { chat: "bob", path: "/f" }, "daemon")).toBeNull();
    expect(waitNotice("chat.delete", { chat: "bob", message: "m" }, "one-shot")).toBeNull();
    expect(waitNotice("chat.send", { chat: "bob", text: "hi" }, "one-shot")).toBeNull();
  });
});
