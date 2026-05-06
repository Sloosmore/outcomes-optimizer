import { test, expect } from '@playwright/test'

const BASE_API = 'http://localhost:3001'

const SANDBOX_ID = process.env.SANDBOX_ID ?? 'test-sandbox'

async function createChatWithArtifact(port: number): Promise<{ chatId: string; url: string }> {
  const url = `https://artifact-${SANDBOX_ID}-${port}.example.com/`
  const chatRes = await fetch(`${BASE_API}/api/chats`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `Artifact tile test - port ${port}` }),
  })
  const chat = (await chatRes.json()) as { id: string }
  await fetch(`${BASE_API}/api/chats/${chat.id}/artifact`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  return { chatId: chat.id, url }
}

/**
 * Tile-rail rendering tests. After the Stage Manager migration, the legacy
 * port-only PATCH path is gone — these tests now PATCH a full URL onto the
 * tile rail and assert the iframe renders that URL.
 */
test('artifact-iframe renders from tiles[0].url on page load', async ({ page }) => {
  const port = 3742
  const expectedHostPrefix = `artifact-${SANDBOX_ID}-${port}.example.com`

  await page.route(new RegExp(`https://artifact-[^.]+-${port}\\.duoidal\\.com/`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html><body>artifact content</body></html>',
    })
  })

  const { chatId } = await createChatWithArtifact(port)
  await page.goto(`/chat/${chatId}`)

  const frame = page.locator('[data-testid="artifact-frame"]')
  await expect(frame).toBeVisible({ timeout: 5000 })

  const src = await frame.getAttribute('src')
  expect(src).toContain(expectedHostPrefix)
  expect(src).toMatch(/^https:\/\/artifact-/)
  expect(src).toContain(String(port))
})

test('artifact-iframe src contains port number from tile url', async ({ page }) => {
  const port = 3743
  await page.route(new RegExp(`https://artifact-[^.]+-${port}\\.duoidal\\.com/`), async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>ok</body></html>' })
  })

  const { chatId } = await createChatWithArtifact(port)
  await page.goto(`/chat/${chatId}`)

  const frame = page.locator('[data-testid="artifact-frame"]')
  await expect(frame).toBeVisible({ timeout: 5000 })

  const src = await frame.getAttribute('src')
  expect(src).toContain(String(port))
  expect(src).toMatch(/^https:\/\/artifact-/)
})
