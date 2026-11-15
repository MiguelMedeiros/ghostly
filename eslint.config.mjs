import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import ghostly from "./tools/eslint/index.mjs";

/** The UI's tests: the ghostly/* rules guard what Tailwind and the bundler read, never these. */
const UI_TESTS = ["apps/ui/src/test/**", "apps/ui/src/**/*.test.{ts,tsx}"];

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // React Compiler rules new in eslint-plugin-react-hooks 7 that the
      // existing hooks code does not meet yet; turn back on once it does.
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/purity": "off",
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // A context file is a provider and the hook that reads it, together on
    // purpose. Fast refresh cannot hot-reload that, and splitting every context
    // in two to please it costs more than it is worth.
    files: ["apps/ui/src/contexts/**/*.tsx"],
    rules: { "react-refresh/only-export-components": "off" },
  },
  {
    // One look and one keyboard for every choice in the app: components/ui/Select.tsx, never a native <select>
    // (WebKit draws it with the system's gradient and double chevron, and its list ignores the app's theme).
    files: ["apps/ui/src/**/*.tsx"],
    ignores: ["apps/ui/src/test/**"],
    rules: {
      "no-restricted-syntax": ["error", { selector: "JSXOpeningElement[name.name='select']", message: "Use Select from apps/ui/src/components/ui/Select.tsx." }],
    },
  },
  {
    files: ["apps/ui/src/**/*.{ts,tsx}"],
    ignores: UI_TESTS,
    plugins: { ghostly },
    rules: { "ghostly/no-group-has": "error", "ghostly/on-accent-ink": "error" },
  },
  {
    // externalLink.ts is where the new window is asked for, the one place allowed to spell `_blank`.
    files: ["apps/ui/src/**/*.{ts,tsx}"],
    ignores: [...UI_TESTS, "apps/ui/src/lib/externalLink.ts"],
    plugins: { ghostly },
    rules: { "ghostly/no-blank-target": "error" },
  },
  {
    // Tailwind reads the stylesheets too: no-group-has reads their lines as comments (the `text` processor).
    files: ["apps/ui/src/**/*.{css,html}"],
    ignores: UI_TESTS,
    plugins: { ghostly },
    processor: "ghostly/text",
  },
  {
    files: ["apps/ui/src/**/*.{css,html}/*.js"],
    plugins: { ghostly },
    rules: { "ghostly/no-group-has": "error" },
  },
  {
    // Component tests and their harness are never hot-reloaded.
    files: ["apps/ui/src/test/**/*.{ts,tsx}", "packages/react/test/**/*.{ts,tsx}"],
    rules: { "react-refresh/only-export-components": "off" },
  },
  {
    // Playwright fixtures call `use()` and take `{}` when they need nothing; neither is React.
    files: ["e2e/**/*.ts"],
    languageOptions: { globals: globals.node },
    rules: {
      "react-hooks/rules-of-hooks": "off",
      "no-empty-pattern": "off",
    },
  }
);
