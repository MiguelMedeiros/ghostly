/**
 * Runs a command for as long as the process that started this one lives:
 *
 *   node runWhileParentLives.mjs <command> [args...]      (stdin: a pipe from the parent)
 *
 * A test's daemon outlived a test runner's worker that was killed on a timeout: its stop runs from the test, which was
 * gone. The pipe closes when the parent ends, however it ends (SIGKILL too), and the command is killed then. The
 * parent closing it is the same: its last resort for a command that does not stop on SIGTERM.
 *
 * The command writes straight to this process's stdout and stderr. A stop signal goes on to it, and its exit code is
 * this one's (1 when a signal ended it).
 */
import { spawn } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
child.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
process.stdin.on("error", () => {}).on("close", () => child.kill("SIGKILL")).resume();
