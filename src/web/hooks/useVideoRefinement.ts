import { useCallback, useState } from 'react'
import type {
  VideoRefinementOptions,
  VideoRefinementResult,
} from '../types'

export function useVideoRefinement() {
  const [result, setResult] = useState<VideoRefinementResult | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refineVideo = useCallback(async (
    file: File,
    options: VideoRefinementOptions,
    projectId?: string,
  ) => {
    setIsProcessing(true)
    setError(null)
    setResult(null)
    try {
      const query = new URLSearchParams({
        targetSpeed: String(options.targetSpeed),
        minimumInactiveDuration: String(options.minimumInactiveDuration),
        clarity: options.clarity,
        resolution: options.resolution,
      })
      if (projectId) {
        query.set('projectId', projectId)
      }
      const response = await fetch(`/video/refine?${query}`, {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name),
        },
        body: file,
      })
      const payload = await response.json() as VideoRefinementResult & { error?: string }
      if (!response.ok) {
        throw new Error(payload.error || `Video refinement failed (${response.status})`)
      }
      setResult(payload)
      return payload
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Video refinement failed'
      setError(message)
      throw caught
    } finally {
      setIsProcessing(false)
    }
  }, [])

  return { result, isProcessing, error, refineVideo }
}
