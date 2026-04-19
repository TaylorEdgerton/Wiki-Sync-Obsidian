export default [
  {
    files: ["*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        Buffer: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        document: "readonly",
        process: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly"
      }
    },
    rules: {
      "curly": ["error", "multi-line"],
      "eqeqeq": ["error", "always"],
      "no-redeclare": "error",
      "no-unreachable": "error",
      "no-unused-vars": ["error", {
        "argsIgnorePattern": "^_",
        "caughtErrorsIgnorePattern": "^_"
      }],
      "no-var": "error",
      "prefer-const": "error"
    }
  }
]
