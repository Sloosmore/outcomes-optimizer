import { useRef, useCallback } from 'react'

const SOUNDS = {
  toggleOn: '/sounds/toggle_on.wav',
  toggleOff: '/sounds/toggle_off.wav',
  progressLoop: '/sounds/progress_loop.wav',
} as const

export function useSoundEffects() {
  const loopRef = useRef<HTMLAudioElement | null>(null)

  const play = useCallback((key: keyof typeof SOUNDS) => {
    const audio = new Audio(SOUNDS[key])
    void audio.play()
  }, [])

  const startLoop = useCallback(() => {
    if (loopRef.current) return
    const audio = new Audio(SOUNDS.progressLoop)
    audio.loop = true
    loopRef.current = audio
    void audio.play()
  }, [])

  const stopLoop = useCallback(() => {
    const audio = loopRef.current
    if (!audio) return
    audio.pause()
    audio.currentTime = 0
    loopRef.current = null
  }, [])

  return { play, startLoop, stopLoop }
}
