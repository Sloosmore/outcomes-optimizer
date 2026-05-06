import { useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark'

function getTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

function getServerTheme(): Theme {
  return 'dark'
}

function subscribe(callback: () => void) {
  const observer = new MutationObserver(callback)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}

/** Reactively tracks the current theme by observing the `dark` class on `<html>`. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, getServerTheme)
}
