import { cn } from '@/lib/utils'

interface ArtifactPanelProps {
  artifact: { port: number; label: string; path?: string; url?: string }
  className?: string
}

export function ArtifactPanel({ artifact, className }: ArtifactPanelProps) {
  const src = artifact.url ?? `http://localhost:${artifact.port}/${artifact.path ?? ''}`
  return (
    <div className={cn('flex flex-col w-full h-full', className)}>
      <div className="px-3 py-2 border-b text-sm font-medium text-foreground shrink-0">
        {artifact.label}
      </div>
      {/* sandbox: allow-scripts + allow-same-origin is safe here because the iframe origin
          (artifact-{sandboxId}-{port}.example.com) is always a different origin from the parent app.
          If these ever share an origin, drop allow-same-origin to prevent sandbox escape. */}
      <iframe
        src={src}
        title={artifact.label}
        sandbox="allow-scripts allow-same-origin allow-forms"
        className="flex-1 w-full border-0"
      />
    </div>
  )
}
