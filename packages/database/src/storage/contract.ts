export interface StorageContract {
  upload(bucket: string, key: string, data: Buffer | Uint8Array, options?: { contentType?: string; metadata?: Record<string, string> }): Promise<void>
  download(bucket: string, key: string): Promise<Buffer>
  list(bucket: string, prefix?: string): Promise<string[]>
}
