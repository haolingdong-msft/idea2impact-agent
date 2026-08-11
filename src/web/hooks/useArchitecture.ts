import { useCallback, useState } from 'react'
import type { ArchitectureGraph, PresentationBrief } from '../types'

export function useArchitecture() {
  const [architecture, setArchitecture] = useState<ArchitectureGraph | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const generateArchitecture = useCallback(async (
    brief: PresentationBrief,
    context = '',
    projectId?: string,
  ) => {
    setIsGenerating(true)
    setError(null)
    try {
      const response = await fetch('/architecture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idea: brief.idea,
          audience: brief.audience,
          purpose: brief.purpose,
          context,
          projectId,
        }),
      })
      const payload = await response.json() as {
        architecture?: ArchitectureGraph
        error?: string
      }
      if (!response.ok || !payload.architecture) {
        throw new Error(payload.error || `Architecture request failed (${response.status})`)
      }
      setArchitecture(payload.architecture)
      return payload.architecture
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Architecture generation failed'
      setError(message)
      throw caught
    } finally {
      setIsGenerating(false)
    }
  }, [])

  return { architecture, isGenerating, error, generateArchitecture }
}
