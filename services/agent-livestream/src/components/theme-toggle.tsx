import { useCallback } from 'react'
import { Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTheme, type Theme } from '@/hooks/use-theme'

const STORAGE_KEY = 'theme'

export function ThemeToggle() {
  const theme = useTheme()

  const toggle = useCallback(() => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.classList.toggle('dark', next === 'dark')
    localStorage.setItem(STORAGE_KEY, next)
  }, [theme])

  return (
    <Button variant="ghost" size="icon-sm" onClick={toggle} aria-label="Toggle theme" className="text-muted-foreground hover:text-foreground transition-colors duration-150">
      {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  )
}
