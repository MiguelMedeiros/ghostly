import { describe, expect, it } from "vitest";
import { shellWord } from "../src/shellWord";
import { pasted } from "./support/pasted";

describe("shellWord", () => {
  it.each(["Crew", "g1crew", "group:Crew", "report.txt", "a/b-c_d@e%f+g,h=i"])("leaves a plain word %s as it is", (word) => {
    expect(shellWord(word)).toBe(word);
  });

  it.each(["$5 lunch", "a`echo x`b", "it's", "=ls", "x!y", "a\\b", "*", "~", "report (2).txt", "a\"b", "$(id)", "two  spaces"])("%s pasted into sh is the same one word", (word) => {
    expect(pasted(shellWord(word))).toEqual([word]);
  });
});
