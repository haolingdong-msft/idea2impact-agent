import { useCallback, useState } from 'react'
import type { RepositoryEvidenceSummary } from '../types'

export function useRepository() {
  const [evidence, setEvidence] = useState<RepositoryEvidenceSummary | null>(null)
  const [isScanning, setIsScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const scanRepository = useCallback(async (
    projectId: string,
    repositoryUrl: string,
  ) => {
    setIsScanning(true)
    setError(null)
    try {
      const response = await fetch(`/projects/${projectId}/repository/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repositoryUrl }),
      })
      const payload = await response.json() as {
        evidence?: RepositoryEvidenceSummary
        error?: string
      }
      if (!response.ok || !payload.evidence) {
        throw new Error(payload.error || `Repository scan failed (${response.status})`)
      }
      setEvidence(payload.evidence)
      return payload.evidence
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Repository scan failed'
      setError(message)
      throw caught
    } finally {
      setIsScanning(false)
    }
  }, [])

  return { evidence, isScanning, error, scanRepository }
}
