/**
 * Tailwind's `group-has-[…]` variant writes a `:has()` rule anchored on every `.group`, and each message row is one:
 * WebKit then pays for every keystroke (and any other change of the page) in proportion to the chat's length. The web
 * e2e (composer-typing-perf) reads the built stylesheet for such a rule, but pull requests do not run it, so this rule
 * says it first. Tailwind reads comments too, so the class may not appear anywhere in a source file, comments included
 * (stylesheets are read through the `text` processor). What to write instead: `has-[…]` on the element itself, or a
 * sibling rule such as `[[data-x]:focus-visible~*_&]:…`.
 */

/** A class Tailwind would build: the variant, its bracket or name, then a utility. The words alone, in prose, are not one. */
const GROUP_HAS = /group-has-(?:\[\S+\]|[\w-]+)(?:\/[\w-]+)?:\S/;

export default {
  meta: {
    type: "problem",
    docs: { description: "No group-has-* class: its :has() rule on every .group costs each keystroke in a long chat" },
    schema: [],
    messages: { groupHas: "group-has-* anchors a :has() rule on every message row: use has-[…] on the element, or a sibling rule such as [[data-x]:focus-visible~*_&]:…" },
  },
  create(context) {
    return {
      Program() {
        context.sourceCode.lines.forEach((text, i) => {
          const found = GROUP_HAS.exec(text);
          if (found) context.report({ loc: { start: { line: i + 1, column: found.index }, end: { line: i + 1, column: found.index + found[0].length } }, messageId: "groupHas" });
        });
      },
    };
  },
};
