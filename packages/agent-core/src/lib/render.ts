import type { Resource, ResourceType } from '@skill-networks/database'

export function renderResource(r: Resource, asJson = false): void {
  if (asJson) {
    console.log(JSON.stringify(r, null, 2))
    return
  }
  // If config.content exists, render it as primary body
  const content = (r.config as Record<string, unknown> | null)?.content
  if (content && typeof content === 'string') {
    console.log(content)
    return
  }
  console.log(`[${r.status.toUpperCase()}] ${r.name}  [${r.type}]`)
  console.log(`  ID:         ${r.id}`)
  if (r.locked_by) {
    console.log(`  Locked by:  ${r.locked_by}`)
    console.log(`  Locked at:  ${r.locked_at}`)
  }
  if (r.config && Object.keys(r.config).length > 0) {
    console.log(`  Config:     ${JSON.stringify(r.config)}`)
  }
  if (r['notes']) console.log(`  Notes:      ${r['notes']}`)
  console.log(`  Created:    ${r.created_at}`)
}

export function renderResources(rows: Resource[], asJson = false): void {
  if (asJson) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }
  if (rows.length === 0) {
    console.log('No resources found.')
    return
  }
  for (const r of rows) {
    renderResource(r, false)
    console.log()
  }
}

export function renderResourceTypes(types: ResourceType[], asJson = false): void {
  if (asJson) {
    console.log(JSON.stringify(types, null, 2))
    return
  }
  console.log(`${'TYPE'.padEnd(14)} ${'FINITE'.padEnd(8)} ${'COUNT'.padEnd(8)} DESCRIPTION`)
  console.log('─'.repeat(70))
  for (const t of types) {
    const finiteStr = t.finite ? 'yes' : 'no'
    console.log(`${t.name.padEnd(14)} ${finiteStr.padEnd(8)} ${String(t.count ?? 0).padEnd(8)} ${t.description}`)
  }
}
