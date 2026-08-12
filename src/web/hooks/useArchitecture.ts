import { useCallback, useState } from 'react'
import type { ArchitectureGraph, ArchitectureVisual, PresentationBrief } from '../types'

export function useArchitecture() {
  const [architecture, setArchitecture] = useState<ArchitectureGraph | null>(null)
  const [visual, setVisual] = useState<ArchitectureVisual | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const generateArchitecture = useCallback(async (
    brief: PresentationBrief,
    context = '',
    projectId?: string,
    generateVisuals = false,
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
          generateVisuals,
        }),
      })
      const responseBody = await response.text()
      if (!responseBody.trim()) {
        throw new Error(
          `Architecture service returned an empty response (${response.status}). ` +
          'The generation connection may have timed out.',
        )
      }
      let payload: {
        architecture?: ArchitectureGraph
        visual?: ArchitectureVisual
        error?: string
      }
      try {
        payload = JSON.parse(responseBody) as typeof payload
      } catch {
        throw new Error(
          `Architecture service returned invalid JSON (${response.status}): ` +
          responseBody.slice(0, 240),
        )
      }
      if (!response.ok || !payload.architecture) {
        throw new Error(payload.error || `Architecture request failed (${response.status})`)
      }
      setArchitecture(payload.architecture)
      setVisual(payload.visual || { mode: 'legacy' })
      return payload.architecture
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Architecture generation failed'
      setError(message)
      throw caught
    } finally {
      setIsGenerating(false)
    }
  }, [])

  return { architecture, visual, isGenerating, error, generateArchitecture }
}
