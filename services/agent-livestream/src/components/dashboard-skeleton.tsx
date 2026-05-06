import { Skeleton } from '@/components/ui/skeleton'

/** Skeleton placeholder for the main dashboard while graph data loads. */
export function DashboardSkeleton() {
  return (
    <div className="flex h-full">
      {/* Left sidebar skeleton — matches SkillDetailPanel (w-64 border-r) */}
      <div className="shrink-0 w-64 border-r px-2 py-3 space-y-6">
        <div className="space-y-1">
          <Skeleton className="h-3 w-16 mb-3" />
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
        <div className="space-y-1">
          <Skeleton className="h-3 w-12 mb-3" />
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </div>

      {/* Main area — single 16:9 pulsing rectangle */}
      <div className="flex-1 flex items-center justify-center p-8">
        <Skeleton className="aspect-video w-full max-w-2xl rounded-xl" />
      </div>
    </div>
  )
}
