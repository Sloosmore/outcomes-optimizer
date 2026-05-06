// Deliberate agent identity color palette — cool blue-teal-violet family for visual harmony. tokens-ok
export const AGENT_COLORS = [
  { fill: 'text-sky-400',    bg: 'bg-sky-400',    hex: '#38bdf8', hex2: '#bae6fd' }, // tokens-ok — agent identity: sky
  { fill: 'text-blue-500',   bg: 'bg-blue-500',   hex: '#3b82f6', hex2: '#bfdbfe' }, // tokens-ok — agent identity: blue
  { fill: 'text-indigo-400', bg: 'bg-indigo-400', hex: '#818cf8', hex2: '#c7d2fe' }, // tokens-ok — agent identity: indigo
  { fill: 'text-violet-400', bg: 'bg-violet-400', hex: '#a78bfa', hex2: '#ddd6fe' }, // tokens-ok — agent identity: violet
  { fill: 'text-cyan-400',   bg: 'bg-cyan-400',   hex: '#22d3ee', hex2: '#a5f3fc' }, // tokens-ok — agent identity: cyan
  { fill: 'text-blue-400',   bg: 'bg-blue-400',   hex: '#60a5fa', hex2: '#bfdbfe' }, // tokens-ok — agent identity: blue-400
] as const

export type AgentColor = (typeof AGENT_COLORS)[number]

export function agentColor(id: string): AgentColor {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0
  }
  return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length]
}
