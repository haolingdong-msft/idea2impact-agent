import { useCallback, useState } from 'react'
import type {
  ArchitectureVisualMode,
  SlideGenerationProgress,
  SlideGenerationResult,
} from '../types'

export function useSlides() {
  const [result, setResult] = useState<SlideGenerationResult | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<SlideGenerationProgress | null>(null)

  const generateSlides = useCallback(async (
    projectId: string,
    architectureVisualMode: ArchitectureVisualMode = 'image',
  ) => {
    setIsGenerating(true)
    setError(null)
    setProgress({
      status: 'running',
      percent: 1,
      stage: 'Starting',
      log: 'Submitting slide generation.',
      completedSlides: 0,
      totalSlides: 0,
    })
    let polling = true
    const pollProgress = async () => {
      while (polling) {
        try {
          const progressResponse = await fetch(
            `/projects/${projectId}/slides/progress`,
          )
          if (progressResponse.ok) {
            setProgress(await progressResponse.json() as SlideGenerationProgress)
          }
        } catch {
          // The generation request remains authoritative during a transient poll failure.
        }
        await new Promise(resolve => setTimeout(resolve, 1_000))
      }
    }
    const progressPromise = pollProgress()
    try {
      const response = await fetch('/slides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(1_200_000),
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
      polling = false
      await progressPromise
      try {
        const finalProgress = await fetch(
          `/projects/${projectId}/slides/progress`,
        )
        if (finalProgress.ok) {
          setProgress(await finalProgress.json() as SlideGenerationProgress)
        }
      } catch {
        // Preserve the last known progress when the final refresh is unavailable.
      }
      setIsGenerating(false)
    }
  }, [])

  const clearSlides = useCallback(() => {
    setResult(null)
    setError(null)
    setProgress(null)
  }, [])

  return { result, progress, isGenerating, error, generateSlides, clearSlides }
}
