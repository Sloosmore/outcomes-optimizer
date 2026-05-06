import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'

/**
 * Question kinds mirror Claude Code's `ask_user` tool: a single-choice prompt
 * (radio buttons — exactly one option must be picked) and a multi-choice
 * prompt (checkboxes — zero or more options). The panel renders the right
 * control per kind. Free-text answers are not part of this surface — when the
 * agent needs prose it should ask in chat, not in the cursor pill.
 */
export type AskUserQuestion =
  | { kind: 'select_one'; text: string; options: string[] }
  | { kind: 'select_multiple'; text: string; options: string[] }

/**
 * Multi-question card that replaces the small process-name pill on a cursor
 * when the agent invokes the `ask_user` tool. Pure presentational — the parent
 * decides when to show it and which questions to ask. Sized for the dashboard
 * cursor view (compact, doesn't dominate the terrain map) and uses semantic
 * tokens so it looks correct in both light and dark themes.
 */
export type AskUserPanelProps = {
  processName: string
  questions: AskUserQuestion[]
  /** Tailwind background class for the header badge (e.g. `bg-rose-500`). Matches the cursor's color. */
  badgeBgClass: string
  className?: string
}

export function AskUserPanel({
  processName,
  questions,
  badgeBgClass,
  className,
}: AskUserPanelProps) {
  return (
    <div className={cn('flex w-72 flex-col gap-3 rounded-md border border-border bg-card p-3 shadow-md pointer-events-auto', className)}>
      <div className="flex items-center justify-between gap-2">
        <Badge
          variant="secondary"
          className={`whitespace-nowrap text-white border-0 ${badgeBgClass}`}
        >
          {processName}
        </Badge>
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          ask_user
        </span>
      </div>
      <ol className="flex flex-col gap-3">
        {questions.map((question, qIdx) => {
          const groupName = `ask-user-${processName}-${qIdx}`
          return (
            <li key={qIdx} className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground">{question.text}</span>
              <div className="flex flex-col gap-1">
                {question.options.map((option, oIdx) => {
                  const inputId = `${groupName}-${oIdx}`
                  return (
                    <label
                      key={oIdx}
                      htmlFor={inputId}
                      className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-0.5 text-xs text-foreground hover:bg-muted"
                    >
                      <input
                        id={inputId}
                        type={question.kind === 'select_one' ? 'radio' : 'checkbox'}
                        name={groupName}
                        readOnly
                        className="h-3.5 w-3.5 accent-primary"
                      />
                      <span>{option}</span>
                    </label>
                  )
                })}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
