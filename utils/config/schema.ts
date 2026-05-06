import { z } from 'zod'

export const cliAdapterSchema = z.enum(['claude-code', 'claude-agent-sdk', 'codex', 'mock'])

// Draft skill paths by CLI adapter
export const CLI_DRAFT_PATHS: Record<z.infer<typeof cliAdapterSchema>, string> = {
  'claude-code': '.claude/skills/',
  'claude-agent-sdk': '.claude/skills/',
  'codex': '.codex/skills/',
  'mock': '.mock/skills/',
}

// Email adapter schema
export const emailAdapterSchema = z.enum(['gmail', 'mailtm', '1secmail'])

// Identity configuration schemas
export const emailIdentitySchema = z.object({
  adapter: emailAdapterSchema,
})

export const phoneIdentitySchema = z.object({
  adapter: z.string().min(1),
  number: z.string().optional(),
})

export const browserIdentitySchema = z.object({
  provider: z.string().min(1),
  session_ttl: z.number().optional(),
})

export const identitySchema = z.object({
  email: emailIdentitySchema.optional(),
  phone: phoneIdentitySchema.optional(),
  browser: browserIdentitySchema.optional(),
})

// Eval data source - discriminated union for cloud/local/none
export const evalDataSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('cloud'),
    training_set: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('local'),
    local_path: z.string().min(1),
  }),
  z.object({
    type: z.literal('none'),
  }),
])

// RL-inspired exploration policy
export const policySchema = z.enum(['value_based', 'policy_gradient', 'actor_critic']).default('value_based')

// Eval configuration schema
export const evalSchema = z.object({
  run_name: z.string().min(1).optional(),
  data: evalDataSchema,
  policy: policySchema.optional(),
  loop: z.object({
    enabled: z.boolean().default(false),
    max_epochs: z.number().int().positive().default(10),
  }).optional(),
}).superRefine((value, ctx) => {
  if (!value) return
  if (value.data.type === 'cloud') {
    const hasTrainingSet = !!value.data.training_set
    const hasRunName = !!value.run_name
    if (!hasTrainingSet && !hasRunName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'eval.run_name or eval.data.training_set is required for cloud data',
        path: ['data', 'training_set'],
      })
    }
  }
}).optional()

export const configSchema = z.object({
  campaign: z.object({
    name: z.string().min(1),
  }),
  database: z.object({
    adapter: z.enum(['none', 'local', 'cloud']),
  }),
  cli: z.object({
    adapter: cliAdapterSchema,
    workingDir: z.string().min(1).optional(),
  }),
  skills: z.object({
    versioned: z.string().min(1),
    // draft path is optional - defaults to CLI adapter's path
    draft: z.string().min(1).optional(),
  }).optional(),
  // Note: When skills section is omitted, runtime fallback in skill-crud/config.ts
  // uses DEFAULT_VERSIONED ('skills/') and CLI adapter path for draft
  identity: identitySchema.optional(),
  eval: evalSchema,
})
