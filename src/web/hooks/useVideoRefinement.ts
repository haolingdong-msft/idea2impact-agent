import { useCallback, useState } from 'react'
import type {
  VideoRefinementOptions,
  VideoRefinementResult,
  UploadedRecording,
} from '../types'

export function useVideoRefinement() {
  const [result, setResult] = useState<VideoRefinementResult | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [upload, setUpload] = useState<UploadedRecording | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const clearUpload = useCallback(() => {
    setUpload(null)
    setResult(null)
    setError(null)
  }, [])

  const uploadVideo = useCallback(async (file: File, projectId: string) => {
    setIsUploading(true)
    setError(null)
    try {
      const response = await fetch(`/video/upload?projectId=${encodeURIComponent(projectId)}`, {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name),
        },
        body: file,
      })
      const payload = await response.json() as UploadedRecording & { error?: string }
      if (!response.ok || !payload.asset) {
        throw new Error(payload.error || `Recording upload failed (${response.status})`)
      }
      setUpload(payload)
      setResult(null)
      return payload
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Recording upload failed')
      throw caught
    } finally {
      setIsUploading(false)
    }
  }, [])

  const refineUploadedVideo = useCallback(async (
    projectId: string,
    sourceAssetId: string,
    options: VideoRefinementOptions,
  ) => {
    setIsProcessing(true)
    setError(null)
    setResult(null)
    try {
      const response = await fetch('/video/refine-stored', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, sourceAssetId, options }),
      })
      const payload = await response.json() as VideoRefinementResult & { error?: string }
      if (!response.ok) {
        throw new Error(payload.error || `Video refinement failed (${response.status})`)
      }
      setResult(payload)
      return payload
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Video refinement failed')
      throw caught
    } finally {
      setIsProcessing(false)
    }
  }, [])

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

  return {
    result,
    upload,
    isUploading,
    isProcessing,
    error,
    uploadVideo,
    refineUploadedVideo,
    refineVideo,
    clearUpload,
  }
}
