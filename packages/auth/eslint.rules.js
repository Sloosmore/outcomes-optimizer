// packages/auth/eslint.rules.js
// Per-package ESLint rules for @duoidal/auth.
// auth.users queries (Supabase-managed schema) must live in src/services/ only.

export default [
  {
    // Ban raw SQL everywhere in @duoidal/auth EXCEPT src/services/
    // src/services/auth-db.ts IS the AuthService — centralized queries live there.
    files: [
      'packages/auth/src/**/*.ts',
    ],
    ignores: [
      'packages/auth/src/services/**/*.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "TaggedTemplateExpression[tag.name='sql']",
          message: "Raw SQL in @duoidal/auth must go through AuthService (src/services/auth-db.ts). The auth.users table depends on Supabase's managed auth schema — centralize all queries in AuthService.",
        },
        {
          selector: "TaggedTemplateExpression[tag.type='MemberExpression'][tag.object.name='sql']",
          message: "Raw SQL in @duoidal/auth must go through AuthService (src/services/auth-db.ts).",
        },
      ],
    },
  },
];
