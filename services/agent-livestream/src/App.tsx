import { createRouter, RouterProvider } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { routeTree } from './routeTree.gen'

const router = createRouter({
  routeTree,
  context: { queryClient: undefined! },
  defaultPreload: 'intent',
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

export default function App() {
  const queryClient = useQueryClient()
  return <RouterProvider router={router} context={{ queryClient }} />
}
