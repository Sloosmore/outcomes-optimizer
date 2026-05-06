#!/usr/bin/env npx tsx

/**
 * One-time script to generate Gmail OAuth refresh token.
 * Run: npx tsx scripts/gmail-auth.ts
 */

import 'dotenv/config'
import { createInterface } from 'readline'

const CLIENT_ID = process.env.GMAIL_CLIENT_ID
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET
const REDIRECT_URI = 'http://localhost'
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly']

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET in .env')
  process.exit(1)
}

// Build auth URL
const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
authUrl.searchParams.set('client_id', CLIENT_ID)
authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
authUrl.searchParams.set('response_type', 'code')
authUrl.searchParams.set('scope', SCOPES.join(' '))
authUrl.searchParams.set('access_type', 'offline')
authUrl.searchParams.set('prompt', 'consent')

console.log('Open this URL in your browser:\n')
console.log(authUrl.toString())
console.log('\nAfter authorizing, you\'ll be redirected to localhost with a code parameter.')
console.log('Copy the "code" value from the URL and paste it below.\n')

const rl = createInterface({ input: process.stdin, output: process.stdout })

rl.question('Code: ', async (code) => {
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: code.trim(),
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
      }),
    })

    const tokens = await response.json()

    if (tokens.error) {
      console.error('\nError:', tokens.error_description || tokens.error)
      rl.close()
      process.exit(1)
    }

    console.log('\n✓ Success! Add this to your .env:\n')
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`)
    console.log('\nAlso add to GitHub secrets:')
    console.log(`gh secret set GMAIL_REFRESH_TOKEN --body "${tokens.refresh_token}"`)
  } catch (err) {
    console.error('Failed to exchange code:', (err as Error).message)
    rl.close()
    process.exit(1)
  }

  rl.close()
})
