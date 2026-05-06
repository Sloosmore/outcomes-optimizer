import type { ReactNode } from 'react'
import type { TrackReference } from '../hooks/use-conversation.js'
import { VideoTrack } from '../hooks/use-conversation.js'
import { cn } from '@/lib/utils'

interface PipLayoutProps {
  screenShareTrack: TrackReference | null
  auraNode: ReactNode
  controlBarNode: ReactNode
  children?: ReactNode
  className?: string
}

export function PipLayout({
  screenShareTrack,
  auraNode,
  controlBarNode,
  children,
  className,
}: PipLayoutProps) {
  if (!screenShareTrack) {
    return (
      <div className={cn('flex flex-1 flex-col items-center justify-center gap-4', className)}>
        {auraNode}
        {children}
        {controlBarNode}
      </div>
    )
  }

  return (
    <div className={cn('relative flex flex-1 flex-col items-center', className)}>
      <div className="flex w-full flex-1 items-center justify-center">
        <div className="aspect-video w-full max-h-full overflow-hidden rounded-lg">
          <VideoTrack trackRef={screenShareTrack} />
        </div>
      </div>
      <div className="absolute bottom-20 right-4">
        {auraNode}
      </div>
      <div className="mt-2">
        {controlBarNode}
      </div>
    </div>
  )
}
