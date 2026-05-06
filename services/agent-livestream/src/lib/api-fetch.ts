import { supabaseClient } from './supabase-client'

export async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const { data: { session } } = await supabaseClient.auth.getSession()
  const headers = new Headers(init?.headers)
  if (session?.access_token) {
    headers.set('Authorization', `Bearer ${session.access_token}`)
  }
  const method = init?.method ?? 'GET'
  const res = await fetch(url, { ...init, headers })
  // Log non-2xx responses for mutating verbs so we can pinpoint silent BFF failures.
  if (!res.ok && (method === 'PATCH' || method === 'POST' || method === 'PUT' || method === 'DELETE')) {
    const cloned = res.clone()
    let body = '<unreadable>'
    try {
      body = await cloned.text()
    } catch { /* swallow */ }
    console.warn('[agent-livestream:api-fetch] non-2xx response', {
      url,
      method,
      status: res.status,
      body: body.slice(0, 500),
    })
  }
  return res
}
