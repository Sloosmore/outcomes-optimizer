// Read from env var — DUOIDAL_API_URL must be set in production
export function getApiBaseUrl(): string {
  const url = process.env['DUOIDAL_API_URL']
  if (!url) {
    throw new Error('DUOIDAL_API_URL environment variable is not set. Run: export DUOIDAL_API_URL=https://<your-api-host>')
  }
  return url
}

export interface ApiClient {
  post<T>(path: string, body: unknown, token?: string): Promise<T>
  get<T>(path: string, token?: string): Promise<T>
}

export function createClient(baseUrl: string = getApiBaseUrl()): ApiClient {
  async function request<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`

    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })

    if (!res.ok) {
      const text = await res.text()
      let detail: string
      try { detail = (JSON.parse(text) as Record<string, unknown>)['error'] as string ?? text } catch { detail = text }
      throw new Error(`API error ${res.status}: ${detail}`)
    }
    return await res.json() as T
  }

  return {
    post: <T>(path: string, body: unknown, token?: string) => request<T>('POST', path, body, token),
    get: <T>(path: string, token?: string) => request<T>('GET', path, undefined, token),
  }
}
