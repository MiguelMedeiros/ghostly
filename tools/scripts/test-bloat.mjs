#!/usr/bin/env node
// Tests that cost CI time and break on refactors without catching a bug.
//
//   node tools/scripts/test-bloat.mjs --weak          list the weak unit and component tests (vitest, outside e2e/)
//   node tools/scripts/test-bloat.mjs --weak --json   the same as JSON, for the weekly report
//
// A test is weak when the matchers it uses (its own `expect`s and those of the helpers it calls from the same file)
// are all of one kind:
//   calls    only toHaveBeenCalled* / toBeCalled*: it checks that a mock was called, not what came of it
//   exists   only toBeDefined / toBeTruthy / toBeInTheDocument: it checks that something is there, not what it is
//   none     no expect or assert at all: it passes unless something throws
// It is a heuristic: a listed test is one to read, not one to delete. A mock call can be the behaviour (a request
// sent, a callback fired), and "it does not throw" can be the point.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");
const SKIP_DIRS = new Set(["node_modules", "dist", "target", ".git", ".claude", "coverage", "website", "notes-local", "gen", "test-results", "playwright-report"]);

const FLAGS = ["--weak", "--json"];
const args = process.argv.slice(2);
if (!args.includes("--weak") || args.some((arg) => !FLAGS.includes(arg))) {
  console.error(`usage: node tools/scripts/test-bloat.mjs --weak [--json]`);
  process.exit(2);
}

const CALLS = /^(toHaveBeenCalled|toHaveBeenCalledWith|toHaveBeenCalledTimes|toHaveBeenLastCalledWith|toHaveBeenNthCalledWith|toHaveBeenCalledOnce|toHaveBeenCalledExactlyOnceWith|toBeCalled|toBeCalledWith|toBeCalledTimes|lastCalledWith|nthCalledWith)$/;
const EXISTS = /^(toBeDefined|toBeTruthy|toBeInTheDocument)$/;
const TEST_NAMES = new Set(["it", "test"]);
const SKIPPED = new Set(["skip", "todo"]);

function walk(dir, out = []) {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (SKIP_DIRS.has(name)) continue;
    const path = dir ? `${dir}/${name}` : name;
    if (statSync(join(ROOT, path)).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}
const files = walk("").map((p) => p.split(sep).join("/")).filter((p) => !p.startsWith("e2e/") && /\.test\.[cm]?[jt]sx?$/.test(p));

/** `it`, `test.only`, `it.each([...])`, `test.concurrent.each`: the test function's name and modifiers, or null. */
function testCallee(expr) {
  const chain = [];
  for (;;) {
    if (ts.isIdentifier(expr)) { chain.unshift(expr.text); break; }
    if (ts.isPropertyAccessExpression(expr)) { chain.unshift(expr.name.text); expr = expr.expression; continue; }
    if (ts.isCallExpression(expr)) { expr = expr.expression; continue; } // it.each([...])("title", fn)
    return null;
  }
  return TEST_NAMES.has(chain[0]) ? chain : null;
}

/** The matcher of `expect(x)[.not|.resolves|.rejects].matcher(...)`, given the call of the matcher. */
function matcherOf(call) {
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  let target = call.expression.expression;
  while (ts.isPropertyAccessExpression(target) && ["not", "resolves", "rejects"].includes(target.name.text)) target = target.expression;
  if (!ts.isCallExpression(target)) return null;
  const callee = target.expression;
  const isExpect = (ts.isIdentifier(callee) && callee.text === "expect")
    || (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "expect");
  return isExpect ? call.expression.name.text : null;
}

/** What a piece of code asserts: its matchers, whether it asserts some other way, and the local functions it calls. */
function scan(node) {
  const found = { matchers: [], other: false, calls: new Set() };
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const matcher = matcherOf(n);
      if (matcher) found.matchers.push(matcher);
      const callee = n.expression;
      if (ts.isIdentifier(callee)) {
        if (/^(assert|expectTypeOf|assertType)/.test(callee.text)) found.other = true;
        else found.calls.add(callee.text);
      }
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        const base = callee.expression.text;
        if (base === "assert" || base === "expectTypeOf") found.other = true;
        // expect.assertions(n), expect.hasAssertions(), expect.unreachable(): an assertion of their own.
        if (base === "expect" && ["assertions", "hasAssertions", "unreachable"].includes(callee.name.text)) found.other = true;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

const weak = [];
for (const path of files) {
  const text = readFileSync(join(ROOT, path), "utf8");
  if (!/\b(it|test)\s*[.(]/.test(text)) continue;
  const kind = /\.[cm]?tsx$|\.jsx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);

  // The file's named functions (declarations and `const f = () => ...`), so a test that asserts through a helper counts.
  const helpers = new Map();
  const collect = (n) => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) helpers.set(n.name.text, scan(n.body));
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
      && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) helpers.set(n.name.text, scan(n.initializer.body));
    ts.forEachChild(n, collect);
  };
  collect(source);
  const resolved = new Map();
  const through = (found, seen = new Set()) => {
    const all = { matchers: [...found.matchers], other: found.other };
    for (const name of found.calls) {
      if (seen.has(name) || !helpers.has(name)) continue;
      seen.add(name);
      const sub = resolved.get(name) ?? through(helpers.get(name), seen);
      resolved.set(name, sub);
      all.matchers.push(...sub.matchers);
      all.other ||= sub.other;
    }
    return all;
  };

  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const chain = testCallee(n.expression);
      const fn = n.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
      if (chain && fn && !chain.some((part) => SKIPPED.has(part))) {
        const { matchers, other } = through(scan(fn.body));
        let reason = null;
        if (!matchers.length && !other) reason = "none";
        else if (!other && matchers.every((m) => CALLS.test(m))) reason = "calls";
        else if (!other && matchers.every((m) => EXISTS.test(m))) reason = "exists";
        if (reason) {
          const title = n.arguments[0];
          const name = title && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title)) ? title.text : title?.getText(source) ?? "";
          const line = source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;
          weak.push({ path, line, reason, title: name, matchers: [...new Set(matchers)] });
        }
        return; // a test inside a test is not a thing
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(source);
}

if (args.includes("--json")) {
  console.log(JSON.stringify(weak, null, 2));
} else {
  for (const t of weak) console.log(`${t.path}:${t.line}  ${t.reason.padEnd(6)}  ${t.title}`);
  const count = (reason) => weak.filter((t) => t.reason === reason).length;
  console.log(`\n${weak.length} weak tests in ${new Set(weak.map((t) => t.path)).size} files (of ${files.length}): ${count("calls")} only check a mock was called, ${count("exists")} only that something exists, ${count("none")} assert nothing`);
}
