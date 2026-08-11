import { useCallback, useState } from 'react'
import type {
  PresentationBrief,
  PresentationProject,
  StorySection,
} from '../types'

export function useProject() {
  const [project, setProject] = useState<PresentationProject | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const createPresentationProject = useCallback(async (brief: PresentationBrief) => {
    setIsSaving(true)
    setError(null)
    try {
      const response = await fetch('/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(brief),
      })
      const payload = await response.json() as {
        project?: PresentationProject
        error?: string
      }
      if (!response.ok || !payload.project) {
        throw new Error(payload.error || `Project creation failed (${response.status})`)
      }
      setProject(payload.project)
      localStorage.setItem('presentationProjectId', payload.project.id)
      return payload.project
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Project creation failed'
      setError(message)
      throw caught
    } finally {
      setIsSaving(false)
    }
  }, [])

  const saveApprovedStory = useCallback(async (
    projectId: string,
    context: string,
    approvedSections: StorySection[],
  ) => {
    setIsSaving(true)
    setError(null)
    try {
      const response = await fetch(`/projects/${projectId}/story`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context, approvedSections }),
      })
      const payload = await response.json() as {
        project?: PresentationProject
        error?: string
      }
      if (!response.ok || !payload.project) {
        throw new Error(payload.error || `Story storage failed (${response.status})`)
      }
      setProject(payload.project)
      return payload.project
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Story storage failed'
      setError(message)
      throw caught
    } finally {
      setIsSaving(false)
    }
  }, [])

  return {
    project,
    isSaving,
    error,
    createPresentationProject,
    saveApprovedStory,
  }
}
