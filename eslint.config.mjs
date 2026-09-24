import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

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
    files: ["src/contexts/**/*.tsx"],
    rules: { "react-refresh/only-export-components": "off" },
  },
  {
    // Component tests and their harness are never hot-reloaded.
    files: ["src/test/**/*.{ts,tsx}", "packages/react/test/**/*.{ts,tsx}"],
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
