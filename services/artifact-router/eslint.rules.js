// Per-package ESLint rules for artifact-router.
// This is a minimal HTTP proxy service — console.log is the appropriate logging
// mechanism (structured logger would be over-engineering for a single-purpose proxy).
export default {
  rules: {
    'no-console': ['warn', { allow: ['log'] }],
  },
}
