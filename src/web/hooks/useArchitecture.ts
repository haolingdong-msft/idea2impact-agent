import { useCallback, useState } from 'react'
import type {
  ArchitectureGraph,
  ArchitectureVisual,
  ArchitectureVisualMode,
  PresentationBrief,
} from '../types'

export interface ArchitectureProgress {
  status: 'idle' | 'running' | 'completed' | 'failed'
  stage: string
  percent: number
  completedTasks: number
  totalTasks: number
  tasks: Array<{
    id: string
    label: string
    status: 'pending' | 'running' | 'completed' | 'failed'
  }>
  startedAt?: string
  updatedAt?: string
  error?: string
}

export function useArchitecture() {
  const [architecture, setArchitecture] = useState<ArchitectureGraph | null>(null)
  const [visual, setVisual] = useState<ArchitectureVisual | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<ArchitectureProgress | null>(null)

  const generateArchitecture = useCallback(async (
    brief: PresentationBrief,
    context = '',
    projectId?: string,
    generateVisuals = false,
    visualMode: ArchitectureVisualMode = 'image',
  ) => {
    setIsGenerating(true)
    setError(null)
    if (generateVisuals && projectId) {
      setProgress({
        status: 'running',
        stage: 'Starting project overview generation',
        percent: 1,
        completedTasks: 0,
        totalTasks: 1,
        tasks: [],
        startedAt: new Date().toISOString(),
      })
    }
    let progressTimer: ReturnType<typeof setInterval> | undefined
    try {
      if (generateVisuals && projectId) {
        const refreshProgress = async () => {
          try {
            const progressResponse = await fetch(
              `/projects/${projectId}/architecture/progress`,
            )
            if (progressResponse.ok) {
              setProgress(await progressResponse.json() as ArchitectureProgress)
            }
          } catch {
            // The generation request remains authoritative if a progress poll fails.
          }
        }
        progressTimer = setInterval(() => void refreshProgress(), 800)
      }
      const response = await fetch('/architecture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(360_000),
        body: JSON.stringify({
          idea: brief.idea,
          audience: brief.audience,
          purpose: brief.purpose,
          context,
          projectId,
          generateVisuals,
          visualMode,
        }),
      })
      const responseBody = await response.text()
      if (!responseBody.trim()) {
        throw new Error(
          `Project overview service returned an empty response (${response.status}). ` +
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
          `Project overview service returned invalid JSON (${response.status}): ` +
          responseBody.slice(0, 240),
        )
      }
      if (!response.ok || !payload.architecture) {
        throw new Error(payload.error || `Project overview request failed (${response.status})`)
      }
      setArchitecture(payload.architecture)
      setVisual(payload.visual || { mode: 'legacy' })
      return payload.architecture
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Project overview generation failed'
      setError(message)
      throw caught
    } finally {
      if (progressTimer) clearInterval(progressTimer)
      if (generateVisuals && projectId) {
        try {
          const finalProgress = await fetch(
            `/projects/${projectId}/architecture/progress`,
          )
          if (finalProgress.ok) {
            setProgress(await finalProgress.json() as ArchitectureProgress)
          }
        } catch {
          // Keep the last known progress state.
        }
      }
      setIsGenerating(false)
    }
  }, [])

  return { architecture, visual, progress, isGenerating, error, generateArchitecture }
}
