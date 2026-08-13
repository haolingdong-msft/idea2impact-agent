import { useCallback, useState } from 'react'
import type { SpeechScript } from '../types'

export function useSpeechScript() {
  const [script, setScript] = useState<SpeechScript | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const clearScript = useCallback(() => {
    setScript(null)
    setError(null)
  }, [])

  const generateScript = useCallback(async (projectId: string) => {
    setIsGenerating(true)
    setError(null)
    try {
      const response = await fetch(`/projects/${projectId}/speech-script/generate`, {
        method: 'POST',
      })
      const payload = await response.json() as { script?: SpeechScript; error?: string }
      if (!response.ok || !payload.script) {
        throw new Error(payload.error || `Speech script generation failed (${response.status})`)
      }
      setScript(payload.script)
      return payload.script
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Speech script generation failed')
      throw caught
    } finally {
      setIsGenerating(false)
    }
  }, [])

  const saveScript = useCallback(async (projectId: string, value: SpeechScript) => {
    setIsSaving(true)
    setError(null)
    try {
      const response = await fetch(`/projects/${projectId}/speech-script`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      })
      const payload = await response.json() as { script?: SpeechScript; error?: string }
      if (!response.ok || !payload.script) {
        throw new Error(payload.error || `Speech script save failed (${response.status})`)
      }
      setScript(payload.script)
      return payload.script
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Speech script save failed')
      throw caught
    } finally {
      setIsSaving(false)
    }
  }, [])

  return {
    script,
    setScript,
    isGenerating,
    isSaving,
    error,
    generateScript,
    saveScript,
    clearScript,
  }
}
