import { useState, type FormEvent } from 'react'
import type { PresentationBrief } from '../types'
import type { GitHubAuthStatus } from '../hooks/useGitHubAuth'

interface Props {
  isLoading: boolean
  onSubmit: (brief: PresentationBrief) => void
  onEdit?: () => void
  githubStatus?: GitHubAuthStatus
  onGitHubLogout?: () => void
}

const INITIAL_BRIEF: PresentationBrief = {
  title: '',
  idea: '',
  audience: '',
  purpose: '',
  repositoryUrl: '',
}

export function IdeaBrief({
  isLoading,
  onSubmit,
  onEdit,
  githubStatus,
  onGitHubLogout,
}: Props) {
  const [brief, setBrief] = useState(INITIAL_BRIEF)

  const update = (field: keyof PresentationBrief, value: string) => {
    onEdit?.()
    setBrief(current => ({ ...current, [field]: value }))
  }

  const normalizedBrief = (): PresentationBrief => ({
    title: brief.title.trim() || 'Turn your idea into a story people remember',
    idea: brief.idea.trim(),
    audience: brief.audience.trim(),
    purpose: brief.purpose.trim(),
    repositoryUrl: brief.repositoryUrl?.trim() || undefined,
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!brief.idea.trim()) return
    onSubmit(normalizedBrief())
  }

  return (
    <form className="brief-card" onSubmit={submit}>
      <div className="brief-heading">
        <div>
          <span className="eyebrow">Step 01 / Start story</span>
          <h2>What are you building?</h2>
          <p>Start with the idea. Optionally connect a GitHub codebase so Copilot can ground the story and overview in code and docs.</p>
        </div>
        <span className="brief-step">01</span>
      </div>

      <div className="brief-inputs">
        <label className="field">
          <span>1. Idea</span>
          <textarea
            value={brief.idea}
            onChange={event => update('idea', event.target.value)}
            placeholder="Describe the product, problem, or concept you want to turn into a compelling story."
            rows={7}
            autoFocus
          />
        </label>

        <label className="field">
          <span>2. GitHub repository link <small>Optional</small></span>
          <input
            type="url"
            value={brief.repositoryUrl || ''}
            onChange={event => update('repositoryUrl', event.target.value)}
            placeholder="https://github.com/owner/repository"
          />
        </label>
      </div>

        {githubStatus?.configured && (
          <div className="github-access">
            {githubStatus.authenticated ? (
              <>
                <span>
                  Connected as <strong>@{githubStatus.user?.login}</strong>
                  {' · '}
                  {githubStatus.installationCount} installation{githubStatus.installationCount === 1 ? '' : 's'}
                </span>
                <button type="button" className="text-button" onClick={onGitHubLogout}>
                  Disconnect
                </button>
              </>
            ) : (
              <>
                <span>Connect GitHub to scan private repositories selected during App installation.</span>
                <a className="secondary-button" href="/auth/github/login?returnTo=/">
                  Connect GitHub
                </a>
              </>
            )}
          </div>
        )}

      <div className="brief-actions">
        <span>Only the idea is required. Repository access is read-only.</span>
        <button className="primary-button" disabled={isLoading || !brief.idea.trim()}>
          {isLoading ? 'Starting story...' : 'Start story'}
          <span aria-hidden="true">-&gt;</span>
        </button>
      </div>
    </form>
  )
}
