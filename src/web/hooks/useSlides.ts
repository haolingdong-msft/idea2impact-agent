import { useCallback, useState } from 'react'
import type { ArchitectureVisualMode, SlideGenerationResult } from '../types'

export function useSlides() {
  const [result, setResult] = useState<SlideGenerationResult | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const generateSlides = useCallback(async (
    projectId: string,
    architectureVisualMode: ArchitectureVisualMode = 'image',
  ) => {
    setIsGenerating(true)
    setError(null)
    try {
      const response = await fetch('/slides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, architectureVisualMode }),
      })
      const responseBody = await response.text()
      if (!responseBody.trim()) {
        throw new Error(
          `Slide service returned an empty response (${response.status}). ` +
          'The generation connection may have timed out.',
        )
      }
      let payload: SlideGenerationResult & { error?: string }
      try {
        payload = JSON.parse(responseBody) as SlideGenerationResult & { error?: string }
      } catch {
        throw new Error(
          `Slide service returned invalid JSON (${response.status}): ` +
          responseBody.slice(0, 240),
        )
      }
      if (!response.ok || !payload.deck) {
        throw new Error(payload.error || `Slide generation failed (${response.status})`)
      }
      setResult(payload)
      return payload
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Slide generation failed'
      setError(message)
      throw caught
    } finally {
      setIsGenerating(false)
    }
  }, [])

  const clearSlides = useCallback(() => {
    setResult(null)
    setError(null)
  }, [])

  return { result, isGenerating, error, generateSlides, clearSlides }
}
