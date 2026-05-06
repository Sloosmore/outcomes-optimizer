// packages/agent-core/eslint.rules.js
// Per-package ESLint rules for agent-core.
// Registered patterns prevent regressions from the DB unification refactor.
// See CLAUDE.md#lint-enforcement for context.

export default [
  {
    // Ban direct service instantiation in command files only.
    // All database access in commands/ must go through getAdapter() (scoped)
    // or getUnscopedAdapter() (admin escape hatch, requires comment explaining why).
    files: ['packages/agent-core/src/commands/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='ResourcesService']",
          message: "Use getAdapter() or getUnscopedAdapter() in command files. Never instantiate services directly.",
        },
        {
          selector: "NewExpression[callee.name='ProcessesService']",
          message: "Use getAdapter() or getUnscopedAdapter() in command files.",
        },
        {
          selector: "NewExpression[callee.name='MetricsService']",
          message: "Use getAdapter() or getUnscopedAdapter() in command files.",
        },
        {
          selector: "NewExpression[callee.name='EventsService']",
          message: "Use getAdapter() in command files — EventsService is always called through the adapter.",
        },
        {
          selector: "TaggedTemplateExpression[tag.name='sql']",
          message: "Raw SQL not allowed in agent-core commands. Use getAdapter() methods or services from packages/database.",
        },
        {
          selector: "TaggedTemplateExpression[tag.type='MemberExpression'][tag.object.name='sql']",
          message: "Raw SQL not allowed in agent-core commands. Use service methods from packages/database.",
        },
      ],
      // Structured logging required in commands/ — ban console.error and console.warn,
      // but allow console.log for stdout output (the commands are CLI tools).
      'no-console': ['error', { allow: ['log'] }],
      // Ban empty catch blocks — silent error swallowing hides bugs.
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },
];
