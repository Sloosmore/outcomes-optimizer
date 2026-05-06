import { createFileRoute, redirect } from '@tanstack/react-router'
import { DEFAULT_SEARCH_PARAMS } from '@/adapters/layout/registry'

export const Route = createFileRoute('/_authenticated/')({
  beforeLoad: ({ context }) => {
    const projects = context.orgData?.projects ?? []
    if (projects.length > 0) {
      throw redirect({
        to: '/p/$projectName',
        params: { projectName: projects[0].name },
        search: DEFAULT_SEARCH_PARAMS,
        replace: true,
      })
    }
    // Fallback: if no projects, stay on this route
    // (the component below shows a no-projects state)
  },
  component: function NoProjectsPage() {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        No projects found. Contact your administrator.
      </div>
    )
  },
})
