import { z } from 'zod'
import { cn } from '@/lib/utils'
import { StoryItemSchema } from '@skill-networks/contracts/process-state'

type StoryItem = z.infer<typeof StoryItemSchema>

function CompletedIcon() {
  return (
    <svg
      className="h-3 w-3 shrink-0 text-foreground"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2 6l3 3 5-5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function InProgressIcon() {
  return (
    <div
      className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-muted border-t-foreground"
      aria-hidden="true"
    />
  )
}

function PendingIcon() {
  return (
    <div
      className="h-3 w-3 shrink-0 rounded-full border border-muted-foreground"
      aria-hidden="true"
    />
  )
}

function TaskItem({ story }: { story: StoryItem }) {
  const isCompleted = story.status === 'completed'
  const isInProgress = story.status === 'in_progress'

  return (
    <li className="flex items-center gap-2 py-1">
      {isCompleted && <CompletedIcon />}
      {isInProgress && <InProgressIcon />}
      {!isCompleted && !isInProgress && <PendingIcon />}
      <span
        className={cn(
          'text-sm',
          isCompleted && 'text-muted-foreground line-through',
          isInProgress && 'text-foreground',
          !isCompleted && !isInProgress && 'text-muted-foreground',
        )}
      >
        {story.label}
      </span>
    </li>
  )
}

export function TaskList({
  stories,
  className,
}: {
  stories: StoryItem[]
  className?: string
}) {
  if (stories.length === 0) return null

  return (
    <ul className={cn('flex flex-col', className)}>
      {stories.map((story) => (
        <TaskItem key={story.id} story={story} />
      ))}
    </ul>
  )
}
