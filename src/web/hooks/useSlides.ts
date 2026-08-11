import { useCallback, useState } from 'react'
import type { SlideGenerationResult } from '../types'

export function useSlides() {
  const [result, setResult] = useState<SlideGenerationResult | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const generateSlides = useCallback(async (projectId: string) => {
    setIsGenerating(true)
    setError(null)
    try {
      const response = await fetch('/slides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      })
      const payload = await response.json() as SlideGenerationResult & { error?: string }
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
