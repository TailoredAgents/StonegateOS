import mystNext from "@myst-os/config/eslint/next";

export default [
  ...mystNext,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      parserOptions: {
        project: undefined
      }
    }
  },
  {
    files: ["public/mobile-sw.js"],
    rules: {
      // This is a browser-served worker script. The app's DOM TypeScript project
      // cannot model ServiceWorkerGlobalScope without conflicting DOM globals.
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/prefer-promise-reject-errors": "off"
    }
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "**/*.mjs"
    ]
  }
];
