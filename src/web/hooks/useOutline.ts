import { useCallback, useRef, useState } from 'react'
import type { Message, PresentationOutline } from '../types'

const EMPTY_OUTLINE: PresentationOutline = {
  problemStatement: '',
  userScenarios: '',
  solution: '',
  status: 'draft',
}

export async function parseOutlineResponse(
  response: Response,
  action: string,
): Promise<{ outline?: PresentationOutline; error?: string }> {
  const body = await response.text()
  if (!body.trim()) {
    throw new Error(`${action} returned an empty response (${response.status}).`)
  }
  try {
    return JSON.parse(body) as {
      outline?: PresentationOutline
      error?: string
    }
  } catch {
    const isHtml = /^\s*<!doctype html/i.test(body) || /^\s*<html/i.test(body)
    throw new Error(
      isHtml
        ? `${action} route is unavailable (${response.status}). Restart the API service and try again.`
        : `${action} returned invalid JSON (${response.status}): ${body.slice(0, 160)}`,
    )
  }
}

export function useOutline() {
  const [outline, setOutline] = useState<PresentationOutline | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const saveDraft = useCallback(async (
    projectId: string,
    value: PresentationOutline,
  ) => {
    setIsSaving(true)
    setError(null)
    try {
      const response = await fetch(`/projects/${projectId}/outline`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      })
      const payload = await parseOutlineResponse(response, 'Outline save')
      if (!response.ok || !payload.outline) {
        throw new Error(payload.error || `Outline save failed (${response.status})`)
      }
      setOutline(payload.outline)
      return payload.outline
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Outline save failed'
      setError(message)
      throw caught
    } finally {
      setIsSaving(false)
    }
  }, [])

  const updateOutline = useCallback((
    projectId: string,
    value: PresentationOutline,
  ) => {
    const draft = { ...value, status: 'draft' as const, approvedAt: undefined }
    setOutline(draft)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void saveDraft(projectId, draft)
    }, 650)
  }, [saveDraft])

  const generateOutline = useCallback(async (
    projectId: string,
    messages: Message[],
  ) => {
    setIsGenerating(true)
    setError(null)
    try {
      const conversation = messages
        .filter(message => message.role !== 'error' && message.content.trim())
        .map(message => `${message.role.toUpperCase()}: ${message.content}`)
        .join('\n\n')
      const response = await fetch(`/projects/${projectId}/outline/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation, currentOutline: outline || EMPTY_OUTLINE }),
      })
      const payload = await parseOutlineResponse(response, 'Outline generation')
      if (!response.ok || !payload.outline) {
        throw new Error(payload.error || `Outline generation failed (${response.status})`)
      }
      return await saveDraft(projectId, payload.outline)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Outline generation failed'
      setError(message)
      throw caught
    } finally {
      setIsGenerating(false)
    }
  }, [outline, saveDraft])

  const approveOutline = useCallback(async (
    projectId: string,
    valueOverride?: PresentationOutline,
  ) => {
    const value = valueOverride || outline
    if (!value) throw new Error('Create an outline before approval.')
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    setIsSaving(true)
    setError(null)
    try {
      await saveDraft(projectId, value)
      const response = await fetch(`/projects/${projectId}/outline/approve`, {
        method: 'POST',
      })
      const payload = await parseOutlineResponse(response, 'Outline approval')
      if (!response.ok || !payload.outline) {
        throw new Error(payload.error || `Outline approval failed (${response.status})`)
      }
      setOutline(payload.outline)
      return payload.outline
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Outline approval failed'
      setError(message)
      throw caught
    } finally {
      setIsSaving(false)
    }
  }, [outline, saveDraft])

  const resetOutline = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    setOutline(null)
    setError(null)
  }, [])

  return {
    outline,
    isGenerating,
    isSaving,
    error,
    generateOutline,
    updateOutline,
    approveOutline,
    resetOutline,
  }
}
