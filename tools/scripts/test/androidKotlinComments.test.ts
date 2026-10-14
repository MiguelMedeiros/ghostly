import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// covers: android.app.boot

/**
 * Kotlin nests block comments: a `/*` inside one (a KDoc that quotes `accept="image/*"`) opens a second comment that
 * nothing closes, and the rest of the file is a comment. `:app:compileUniversalDebugKotlin` then fails with "Unclosed
 * comment", which only the APK builds see (android.yml, android-native.yml): they are not part of CI Success. This
 * reads the Android app's Kotlin the way its lexer does, far enough to tell a comment from a string.
 */
const ANDROID = join(import.meta.dirname, "../../../apps/desktop/gen/android");
/** What a build writes (.gitignore there): not the repository's. */
const BUILT = /(^|\/)(build|\.gradle|\.tauri|generated)\//;

/** The lines where Kotlin opens a comment inside a comment, or opens one that never closes. */
function openComments(source: string): string[] {
  const found: string[] = [];
  // What is being read, innermost last: code (with its open braces), or a string whose `${` starts code again.
  const stack: Array<{ kind: "code"; braces: number } | { kind: "string" | "raw" }> = [{ kind: "code", braces: 0 }];
  let depth = 0;
  let opened = 0;
  let line = 1;
  for (let i = 0; i < source.length; ) {
    const at = (text: string) => source.startsWith(text, i);
    const top = stack[stack.length - 1];
    if (source[i] === "\n") line++;
    if (depth > 0) {
      if (at("/*")) {
        found.push(`${line}: a /* inside a comment`);
        depth++;
        i += 2;
      } else if (at("*/")) {
        depth--;
        i += 2;
      } else i++;
    } else if (top.kind === "code") {
      if (at("//")) {
        const end = source.indexOf("\n", i);
        i = end < 0 ? source.length : end;
      } else if (at("/*")) {
        depth = 1;
        opened = line;
        i += 2;
      } else if (at('"""')) {
        stack.push({ kind: "raw" });
        i += 3;
      } else if (at('"')) {
        stack.push({ kind: "string" });
        i++;
      } else if (at("'")) {
        // A character: 'a', '"', '\'' or '\u0041'.
        const end = source.indexOf("'", source[i + 1] === "\\" ? i + 3 : i + 2);
        i = end < 0 ? source.length : end + 1;
      } else {
        if (at("{")) top.braces++;
        else if (at("}") && top.braces-- === 0 && stack.length > 1) stack.pop();
        i++;
      }
    } else if (at("${")) {
      stack.push({ kind: "code", braces: 0 });
      i += 2;
    } else if (top.kind === "string") {
      if (at("\\")) i += 2;
      else {
        // A string ends at its quote, and at the end of its line at the latest.
        if (at('"') || at("\n")) stack.pop();
        i++;
      }
    } else if (at('"""')) {
      // A raw string ends at the last three of a run of quotes.
      while (at('"')) i++;
      stack.pop();
    } else i++;
  }
  if (depth > 0) found.push(`${opened}: a comment that never closes`);
  return found;
}

describe("the reader of Kotlin comments", () => {
  it("finds a /* inside a KDoc, and the comment it leaves open", () => {
    const source = ['/** A photo input (`accept="image/*" capture`). */', "fun takesPhoto() = true", ""].join("\n");
    expect(openComments(source)).toEqual(["1: a /* inside a comment", "1: a comment that never closes"]);
    expect(openComments("fun a() = 1\n/* one\n * /* two */\n */\nfun b() = 2\n")).toEqual(["3: a /* inside a comment"]);
  });

  it("takes a /* in a string, a character or a line comment for what it is", () => {
    const source = [
      "/** Whether the input asks for a photo. */",
      'fun takesPhoto(types: Array<String>) = "image/*" in types && "video/*" !in types // not "*/*"',
      'val raw = """a "quoted" /* glob""""',
      "val quote = '\"' // then /* in a line comment",
      'val escaped = "\\"/*"',
      'val built = "${types.joinToString("/*") { "$it/*" }}/*"',
      "/* closed */",
    ].join("\n");
    expect(openComments(source)).toEqual([]);
  });
});

it("no comment in the Android app's Kotlin opens another", () => {
  const files = (readdirSync(ANDROID, { recursive: true }) as string[])
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => /\.kts?$/.test(file) && !BUILT.test(file))
    .sort();
  expect(files).toContain("app/src/main/java/tools/ghostly/app/CameraCapture.kt");
  const found = files.flatMap((file) => openComments(readFileSync(join(ANDROID, file), "utf8")).map((what) => `${file}:${what}`));
  expect(found).toEqual([]);
});
