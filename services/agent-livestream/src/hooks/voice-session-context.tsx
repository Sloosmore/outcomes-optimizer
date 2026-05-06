// Exports both a provider component and a hook — fast-refresh does not apply to context/hook files
/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext } from 'react'
import { useVoiceSession } from './use-voice-session'

type VoiceSessionCtx = ReturnType<typeof useVoiceSession>

const VoiceSessionContext = createContext<VoiceSessionCtx | null>(null)

export function VoiceSessionProvider({ children }: { children: React.ReactNode }) {
  const session = useVoiceSession()
  return <VoiceSessionContext.Provider value={session}>{children}</VoiceSessionContext.Provider>
}

export function useVoiceSessionCtx(): VoiceSessionCtx {
  const ctx = useContext(VoiceSessionContext)
  if (!ctx) throw new Error('useVoiceSessionCtx must be used within VoiceSessionProvider')
  return ctx
}
