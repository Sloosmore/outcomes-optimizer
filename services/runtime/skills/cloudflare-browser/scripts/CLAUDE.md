# runtime/skills/cloudflare-browser/scripts

CDP client scripts for the cloudflare-browser skill.

| Script | Purpose |
|---|---|
| `cdp-client.js` | Shared CDP WebSocket client — handles connection, target creation, and message dispatch |
| `screenshot.js` | Capture a single page as PNG: `node screenshot.js <url> <output.png>` |
| `video.js` | Capture multi-page video: `node video.js "<url1,url2>" <output.mp4>` |

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
