import mystNext from "@myst-os/config/eslint/next";
import typescriptEslint from "@typescript-eslint/eslint-plugin";

export default [
  ...mystNext,
  {
    ...typescriptEslint.configs["flat/disable-type-checked"],
    files: ["**/*.js", "**/*.mjs"],
    rules: {
      ...typescriptEslint.configs["flat/disable-type-checked"].rules,
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "**/*.mjs",
      "**/*.cjs",
    ],
  },
];
