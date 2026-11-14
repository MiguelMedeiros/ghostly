import { describe, expect, it } from "vitest";
import { jsonOut } from "../src/jsonOut";
import { shellWord } from "../src/shellWord";
import { pasted } from "./support/pasted";

describe("shellWord", () => {
  it.each(["Crew", "g1crew", "group:Crew", "report.txt", "a/b-c_d@e%f+g,h=i"])("leaves a plain word %s as it is", (word) => {
    expect(shellWord(word, "<id>")).toBe(word);
  });

  it.each(["$5 lunch", "a`echo x`b", "=ls", "x!y", "*", "~", "report (2).txt", "$(id)", "two  spaces"])("%s pasted into sh, as the JSON answer prints it, is the same one word", (word) => {
    const printed = jsonOut(shellWord(word, "<id>")).slice(1, -1);
    expect(pasted(printed)).toEqual([word]);
  });

  it.each(["it's", "a'; echo ran; 'b", "a\\b", "a\"b", "tab\there"])("%s, which no quoting keeps one word as JSON prints it, is said as what stands for it", (word) => {
    expect(shellWord(word, "<id>")).toBe("<id>");
  });
});
