import { Rpc } from '@opencode/plugin/rpc'
import { z } from 'zod'

const quotaSnapshotSchema = z.object({
  provider: z.string(),
  account: z.string().optional(),
  remaining: z.number().nullable(),
  limit: z.number().nullable(),
  unit: z.literal('percent'),
  resetAt: z.string().nullable(),
  observedAt: z.string(),
  source: z.literal('provider_api'),
  status: z.enum(['available', 'unavailable']),
  message: z.string().optional()
})

const usageResponseSchema = z.object({
  fetchedAt: z.string(),
  snapshots: z.array(quotaSnapshotSchema),
  status: z.literal('ready')
})

export type QuotaSnapshot = z.infer<typeof quotaSnapshotSchema>
export type UsageResponse = z.infer<typeof usageResponseSchema>

export const usageRpc = Rpc.define({
  id: 'opencode.usage',
  methods: {
    snapshot: {
      input: z.object({}),
      output: usageResponseSchema
    }
  },
  events: {}
})
