/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  transform: {
    "^.+\\.tsx?$": "babel-jest",
  },
  // Source imports use NodeNext-style explicit ".js" extensions (required at
  // runtime) even though the files on disk are ".ts" — Jest's resolver needs
  // this stripped so it can find the real file.
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  testMatch: ["<rootDir>/src/**/*.test.ts"],
};
