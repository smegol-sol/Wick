export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "header-max-length": [2, "always", 100],
    // Subjects name things as they are written: LP, RPC, PumpSwap, Dependabot's "Bump x from a to b".
    "subject-case": [0],
    "body-max-line-length": [0],
  },
};
