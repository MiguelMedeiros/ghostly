import { execFileSync } from "node:child_process";

/** The arguments `sh` reads from `words`, as a hint's command line pasted into a shell gives them. */
export const pasted = (words: string): string[] => execFileSync("sh", ["-c", `printf '%s\\0' ${words}`], { encoding: "utf8" }).split("\0").slice(0, -1);
