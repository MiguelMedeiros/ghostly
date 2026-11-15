// The repository's own lint rules (eslint.config.mjs turns them on for the files they guard). Each one was a test that
// scanned apps/ui/src/; as a rule it shows at the line in the editor, and `npm run lint` fails on it in CI.
import noBlankTarget from "./noBlankTarget.mjs";
import noGroupHas from "./noGroupHas.mjs";
import onAccentInk from "./onAccentInk.mjs";

const PREFIX = "// ";

export default {
  meta: { name: "ghostly" },
  rules: { "no-blank-target": noBlankTarget, "no-group-has": noGroupHas, "on-accent-ink": onAccentInk },
  processors: {
    /**
     * A file ESLint cannot parse (a stylesheet) read as JavaScript whose every line is a comment, so a rule that reads
     * the lines (no-group-has) sees its text at the same line numbers. Messages come back at the file's own columns.
     */
    text: {
      meta: { name: "text" },
      preprocess: (text) => [{ text: text.split(/\r\n|[\r\n\u2028\u2029]/).map((line) => PREFIX + line).join("\n"), filename: "text.js" }],
      postprocess: (messages) => messages.flat().map((m) => ({
        ...m,
        column: Math.max(1, m.column - PREFIX.length),
        ...(m.endColumn ? { endColumn: Math.max(1, m.endColumn - PREFIX.length) } : {}),
      })),
      supportsAutofix: false,
    },
  },
};
