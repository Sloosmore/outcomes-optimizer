import { ProcessEventSchema, ApiProcessSchema } from '@skill-networks/contracts/processes'

describe('BFF contract schemas', () => {
  describe('ProcessEventSchema payload round-trip (T7)', () => {
    it('preserves nested payload through Zod parse', () => {
      const row = {
        id: 'evt-1',
        process_id: 'proc-1',
        resource_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        source: 'Bash',
        payload: { tool_use_id: 'tu-1', input: { command: 'date +%s' } },
        ts: '2026-03-24T00:00:00Z',
      }

      const parsed = ProcessEventSchema.parse(row)
      expect((parsed.payload as Record<string, unknown>).tool_use_id).toBe('tu-1')
      expect(((parsed.payload as Record<string, unknown>).input as Record<string, unknown>).command).toBe('date +%s')
    })

    it('accepts null payload', () => {
      const row = {
        id: 'evt-2',
        process_id: 'proc-1',
        resource_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        source: 'result:success',
        payload: null,
        ts: '2026-03-24T00:00:01Z',
      }

      const parsed = ProcessEventSchema.parse(row)
      expect(parsed.payload).toBeNull()
    })

    it('accepts missing payload', () => {
      const row = {
        id: 'evt-3',
        process_id: 'proc-1',
        resource_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        source: 'assistant',
        ts: '2026-03-24T00:00:02Z',
      }

      const parsed = ProcessEventSchema.parse(row)
      expect(parsed.payload).toBeUndefined()
    })
  })

  describe('ApiProcessSchema', () => {
    it('accepts nullable current_epoch', () => {
      const row = {
        id: '00000000-0000-0000-0000-000000000000',
        name: 'test-process',
        status: 'active',
        current_epoch: null,
        skill_resource_id: null,
        updated_at: '2026-03-24T00:00:00Z',
        created_at: '2026-03-24T00:00:00Z',
      }

      const parsed = ApiProcessSchema.parse(row)
      expect(parsed.current_epoch).toBeNull()
    })

    it('accepts started_at field', () => {
      const row = {
        id: '00000000-0000-0000-0000-000000000000',
        name: null,
        status: 'active',
        current_epoch: null,
        skill_resource_id: null,
        updated_at: '2026-03-24T00:00:00Z',
        created_at: '2026-03-24T00:00:00Z',
        started_at: '2026-03-24T00:01:00Z',
      }

      const parsed = ApiProcessSchema.parse(row)
      expect(parsed.started_at).toBe('2026-03-24T00:01:00Z')
    })
  })
})
