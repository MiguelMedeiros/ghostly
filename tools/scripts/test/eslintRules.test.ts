import { join } from "node:path";
import { ESLint, RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import ghostly from "../../eslint/index.mjs";
// covers: app.external-links, app.theme.on-accent, app.composer.typing-cost

/** The repository's own lint rules (tools/eslint/): each bad case is one the scan tests they replace refused. */
const ROOT = join(import.meta.dirname, "../../..");

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;
const tester = new RuleTester({ languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } } });
const tsx = (code: string) => ({ code, filename: "sample.tsx" });

tester.run("ghostly/no-blank-target", ghostly.rules["no-blank-target"], {
  valid: [tsx(`const d = <a href={u} target="_self" title="blank">x</a>;`), tsx("const e = `${a}_blank_`;")],
  invalid: [
    `const a = <a href={u} target="_blank">x</a>;`,
    `const b = <a href={u} target={"_BLANK"}>x</a>;`,
    "const c = { target: `_blank` };",
    `window.open(u, "_blank");`,
    "window.open(u, `${x}_blank`);",
  ].map((code) => ({ ...tsx(code), errors: [{ messageId: "blank" }] })),
});

tester.run("ghostly/on-accent-ink", ghostly.rules["on-accent-ink"], {
  valid: [
    tsx(`const a = <b className="bg-accent text-on-accent">x</b>;`),
    tsx(`const b = <b className="bg-accent/20 text-white">x</b>;`),
    // One branch's accent is not paired with the other branch's ink.
    tsx("const c = <b className={`px-2 ${on ? \"bg-accent text-on-accent\" : \"bg-black text-white\"}`}>x</b>;"),
  ],
  invalid: [
    { code: `const a = <b className="bg-accent text-white">x</b>;`, ink: "text-white" },
    { code: `const b = <b className="!bg-accent-hover !text-black">x</b>;`, ink: "!text-black" },
    { code: "const c = `bg-accent ${size} text-[#fff]`;", ink: "text-[#fff]" },
    { code: `const d = ["p-1", "bg-accent text-[rgba(0,0,0,0.8)]"];`, ink: "text-[rgba(0,0,0,0.8)]" },
  ].map(({ code, ink }) => ({ ...tsx(code), errors: [{ messageId: "ink", data: { ink } }] })),
});

tester.run("ghostly/no-group-has", ghostly.rules["no-group-has"], {
  valid: [
    tsx(`const a = "has-[:focus-visible]:opacity-100 group-hover:opacity-100";`),
    tsx(`// The words group-has, in prose, are not a class.`),
  ],
  invalid: [
    { ...tsx(`const a = <b className="truncate group-has-[[data-board-card]:focus-visible]:whitespace-normal">x</b>;`), errors: [{ messageId: "groupHas", line: 1, column: 34 }] },
    { ...tsx(`/* group-has-[:focus-visible]:opacity-100 */`), errors: [{ messageId: "groupHas" }] },
    { ...tsx(`\nconst c = "group-has-checked/row:underline";`), errors: [{ messageId: "groupHas", line: 2 }] },
  ],
});

describe("npm run lint turns them on where they guard", () => {
  const eslint = new ESLint({ cwd: ROOT });
  const ruleIds = async (path: string, code: string) =>
    (await eslint.lintText(code, { filePath: join(ROOT, path) }))[0].messages.filter((m) => m.ruleId?.startsWith("ghostly/")).map((m) => `${m.ruleId} ${m.line}:${m.column}`).sort();

  it("in apps/ui/src/, every file the app is built from, stylesheets included", async () => {
    expect(await ruleIds("apps/ui/src/components/Sample.tsx", `export const A = () => <a target="_blank" className="bg-accent text-white group-has-[x]:p-1">x</a>;`))
      .toEqual(["ghostly/no-blank-target 1:34", "ghostly/no-group-has 1:75", "ghostly/on-accent-ink 1:53"]);
    expect(await ruleIds("apps/ui/src/components/sample.css", ".a {}\n  .b { @apply group-has-[:checked]:flex; }\n")).toEqual(["ghostly/no-group-has 2:15"]);
  }, 60_000);

  it("but in externalLink.ts, for _blank, and in the tests", async () => {
    expect(await ruleIds("apps/ui/src/lib/externalLink.ts", `export const target = "_blank";`)).toEqual([]);
    expect(await ruleIds("apps/ui/src/test/ui/sample.test.tsx", `const a = <a target="_blank" className="bg-accent text-white group-has-[x]:p-1">x</a>;`)).toEqual([]);
  }, 60_000);
});
