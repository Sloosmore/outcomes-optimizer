// services/credential-proxy/eslint.rules.js
// Per-package ESLint rules for credential-proxy.
// All SQL queries must live in packages/database/src/services/.

export default [
  {
    files: [
      'services/credential-proxy/src/**/*.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "TaggedTemplateExpression[tag.name='sql']",
          message: "Raw SQL not allowed in credential-proxy. Use CredentialResolverService from packages/database/src/services/credential-resolver.ts.",
        },
        {
          selector: "TaggedTemplateExpression[tag.type='MemberExpression'][tag.object.name='sql']",
          message: "Raw SQL not allowed in credential-proxy. Use CredentialResolverService from packages/database/src/services/.",
        },
      ],
      // Structured logger required — no raw console in credential-proxy
      'no-console': 'error',
    },
  },
];
