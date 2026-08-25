import mystNext from "@myst-os/config/eslint/next";
import typescriptEslint from "@typescript-eslint/eslint-plugin";

export default [
  ...mystNext,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: process.cwd(),
      },
    },
  },
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
