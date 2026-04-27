const nextJest = require("next/jest");

const createJestConfig = nextJest({
  dir: "./",
});

/** @type {import('jest').Config} */
const customJestConfig = {
  testEnvironment: "jest-environment-jsdom",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  testPathIgnorePatterns: [
    "<rootDir>/.next/",
    "<rootDir>/node_modules/",
    // Planning legacy ~12k lignes : exécuter avec `npx jest director-planning-page`
    "<rootDir>/src/__tests__/director-planning-page.test.tsx",
  ],
};

module.exports = createJestConfig(customJestConfig);

