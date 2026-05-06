import { createFileRoute, redirect, Outlet } from '@tanstack/react-router'
import { DEFAULT_SEARCH_PARAMS } from '@/adapters/layout/registry'

export const Route = createFileRoute('/_authenticated/p/$projectName')({
  beforeLoad: ({ params, context }) => {
    const { projectName } = params
    const projects = context.orgData?.projects ?? []

    if (projects.length === 0) return // no projects, let page render

    // Check if the project name is valid
    const isValid = projects.some((p) => p.name === projectName)
    if (!isValid) {
      // Redirect to the first (default) project
      throw redirect({
        to: '/p/$projectName',
        params: { projectName: projects[0].name },
        search: DEFAULT_SEARCH_PARAMS,
        replace: true,
      })
    }
  },
  component: function ProjectLayout() {
    return <Outlet />
  },
})
