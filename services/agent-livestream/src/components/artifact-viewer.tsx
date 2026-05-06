import { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import mermaid from 'mermaid'
import type { ReactNode } from 'react'

mermaid.initialize({ startOnLoad: false })

// Module-level counter — stable across renders, no impure calls during render
let mermaidCounter = 0

function MermaidBlock({ src }: { src: string }) {
  // Counter assigned once at creation time (ref initializer runs once per instance)
  const id = useRef(`mermaid-${++mermaidCounter}`)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ref.current) return
    mermaid.render(id.current, src).then(({ svg }) => {
      if (ref.current) ref.current.innerHTML = svg
    }).catch(() => {
      if (ref.current) ref.current.textContent = src
    })
  }, [src])

  return <div ref={ref} data-testid="artifact-mermaid" />
}

const renderers: Record<string, (content: string) => ReactNode> = {
  md: (src) => <ReactMarkdown>{src}</ReactMarkdown>,
  mermaid: (src) => <MermaidBlock src={src} />,
}

interface ArtifactViewerProps {
  ext: string
  content: string
}

export function ArtifactViewer({ ext, content }: ArtifactViewerProps) {
  const render = renderers[ext]
  if (render) {
    return <div data-testid={`artifact-${ext}`}>{render(content)}</div>
  }
  return <pre data-testid="artifact-viewer">{content}</pre>
}
