/** @type {import('jest').Config} */
const config = {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts", ".tsx"],
  testMatch: ["**/?(*.)+(test|spec).ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^@/app/api/team/auth$": "<rootDir>/../site/src/app/api/team/auth.ts",
    "^@/app/api/team/redirects$":
      "<rootDir>/../site/src/app/api/team/redirects.ts",
    "^@/app/team/access-role-page$":
      "<rootDir>/../site/src/app/team/access-role-page.ts",
    "^@/app/team/lib/api$": "<rootDir>/../site/src/app/team/lib/api.ts",
    "^@/app/team/lib/conversation-export$":
      "<rootDir>/../site/src/app/team/lib/conversation-export.ts",
    "^@/app/team/pipeline-presets$":
      "<rootDir>/../site/src/app/team/pipeline-presets.ts",
    "^@/app/team/components/pipeline\\.stages$":
      "<rootDir>/../site/src/app/team/components/pipeline.stages.ts",
    "^@/(.*)$": "<rootDir>/src/$1",
    "^@myst-os/pricing$": "<rootDir>/../../packages/pricing/src/index.ts",
    "^@myst-os/pricing/(.*)$": "<rootDir>/../../packages/pricing/$1",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: "<rootDir>/tsconfig.jest.json",
      },
    ],
  },
  moduleDirectories: ["node_modules", "<rootDir>/node_modules"],
};

module.exports = config;
