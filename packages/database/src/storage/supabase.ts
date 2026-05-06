import { type SupabaseClient } from '@supabase/supabase-js'
import { type StorageContract } from './contract.js'

export function createSupabaseStorageAdapter(client: SupabaseClient): StorageContract {
  return {
    async upload(bucket, key, data, options) {
      const { error } = await client.storage.from(bucket).upload(key, data, {
        upsert: true,
        contentType: options?.contentType,
        metadata: options?.metadata,
      })
      if (error) throw error
    },

    async download(bucket, key) {
      const { data, error } = await client.storage.from(bucket).download(key)
      if (error) throw error
      return Buffer.from(await data.arrayBuffer())
    },

    async list(bucket, prefix) {
      const { data, error } = await client.storage.from(bucket).list(prefix ?? '')
      if (error) throw error
      return data.map(o => o.name)
    },
  }
}
