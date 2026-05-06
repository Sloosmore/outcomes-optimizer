// services/agent-livestream/eslint.rules.js
// Per-package ESLint rules for agent-livestream.
// SQL in routes/ and scripts/ must go through AuthService or ResourcesService.

export default [
  {
    files: [
      'services/agent-livestream/server/**/*.ts',
      'services/agent-livestream/scripts/**/*.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "TaggedTemplateExpression[tag.name='sql']",
          message: "Raw SQL in agent-livestream is not allowed. Use AuthService (packages/auth/src/services/auth-db.ts) for auth queries, ResourcesService for resource operations.",
        },
        {
          selector: "TaggedTemplateExpression[tag.type='MemberExpression'][tag.object.name='sql']",
          message: "Raw SQL in agent-livestream is not allowed. Use service classes from packages/.",
        },
      ],
    },
  },
];
