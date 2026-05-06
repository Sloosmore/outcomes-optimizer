import { useQuery } from '@tanstack/react-query'
import { ArtifactViewer } from './artifact-viewer'
import { apiFetch } from '@/lib/api-fetch'

interface ArtifactCardProps {
  path: string
}

export function ArtifactCard({ path }: ArtifactCardProps) {
  const { data: content, isError } = useQuery({
    queryKey: ['artifact', path],
    queryFn: () =>
      apiFetch(`/api/artifacts/${path}`).then((r) =>
        r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)),
      ),
  })

  if (isError) {
    return (
      <pre data-testid="artifact-viewer" className="text-muted-foreground text-xs p-2 bg-muted rounded">
        File not available: {path}
      </pre>
    )
  }

  if (!content) {
    return (
      <div data-testid="artifact-viewer" className="text-muted-foreground text-xs">
        Loading...
      </div>
    )
  }

  const ext = path.split('.').pop() ?? ''
  return <ArtifactViewer ext={ext} content={content} />
}
