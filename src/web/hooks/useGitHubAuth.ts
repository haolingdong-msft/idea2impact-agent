import { useCallback, useEffect, useState } from 'react'

export type GitHubAuthStatus = {
  configured: boolean
  authenticated: boolean
  user: { id: number; login: string } | null
  installationCount: number
}

const INITIAL_STATUS: GitHubAuthStatus = {
  configured: false,
  authenticated: false,
  user: null,
  installationCount: 0,
}

export function useGitHubAuth() {
  const [status, setStatus] = useState(INITIAL_STATUS)
  const [isLoading, setIsLoading] = useState(true)

  const refresh = useCallback(async () => {
    setIsLoading(true)
    try {
      const response = await fetch('/auth/github/status')
      if (!response.ok) return
      setStatus(await response.json() as GitHubAuthStatus)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const logout = useCallback(async () => {
    await fetch('/auth/github/logout', { method: 'POST' })
    await refresh()
  }, [refresh])

  return { status, isLoading, logout }
}
