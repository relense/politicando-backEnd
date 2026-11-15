import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "drizzle"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Allows dropping fields with `const { a, ...rest } = object`.
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
);
