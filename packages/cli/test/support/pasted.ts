import { execFileSync } from "node:child_process";

/** The arguments `sh` reads from `words`, as a hint's command line pasted into a shell gives them. */
export const pasted = (words: string): string[] =>
  JSON.parse(execFileSync("sh", ["-c", `"$0" -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- ${words}`, process.execPath], { encoding: "utf8" })) as string[];
