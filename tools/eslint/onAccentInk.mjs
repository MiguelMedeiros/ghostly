/**
 * The accent is dark in some themes (#0a0a0a in monochrome light) and white in others (monochrome dark), so no fixed
 * ink reads on it everywhere: text on `bg-accent` takes `text-on-accent`, which each theme sets in apps/ui/src/index.css.
 * This rule refuses a class list that pairs a solid accent background with a fixed ink. A template literal is read
 * with its `${…}` parts left out: a ternary inside is its own strings, so one branch's accent is not paired with the
 * other branch's ink.
 */

/** A solid accent background (`bg-accent`, `!bg-accent`, `bg-accent-hover`), not a tint like `bg-accent/20`. */
const ON_ACCENT = /(?:^|\s)!?bg-accent(?:-hover)?(?=\s|$)/;
/** A fixed ink: white, black, or a hex/rgb/hsl colour in brackets. */
const FIXED_INK = /(?:^|\s)!?text-(?:white|black|\[(?:#|rgba?\(|hsla?\())[^\s]*/;

export default {
  meta: {
    type: "problem",
    docs: { description: "Text on bg-accent takes text-on-accent, never a fixed ink" },
    schema: [],
    messages: { ink: "{{ink}} on bg-accent is unreadable in some themes: use text-on-accent." },
  },
  create(context) {
    const check = (node, classes) => {
      if (typeof classes !== "string" || !ON_ACCENT.test(classes)) return;
      const ink = classes.match(FIXED_INK);
      if (ink) context.report({ node, messageId: "ink", data: { ink: ink[0].trim() } });
    };
    return {
      Literal: (node) => check(node, node.value),
      TemplateLiteral: (node) => check(node, node.quasis.map((quasi) => quasi.value.cooked ?? "").join(" ")),
    };
  },
};
