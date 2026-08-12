import { useState, type FormEvent } from 'react'
import type { PresentationBrief } from '../types'
import type { GitHubAuthStatus } from '../hooks/useGitHubAuth'

interface Props {
  isLoading: boolean
  onSubmit: (brief: PresentationBrief) => void
  onQuickGenerate?: (brief: PresentationBrief) => void
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
  onQuickGenerate,
  githubStatus,
  onGitHubLogout,
}: Props) {
  const [brief, setBrief] = useState(INITIAL_BRIEF)

  const update = (field: keyof PresentationBrief, value: string) => {
    setBrief(current => ({ ...current, [field]: value }))
  }

  const normalizedBrief = (): PresentationBrief => ({
    title: brief.title.trim() || 'Untitled presentation',
    idea: brief.idea.trim(),
    audience: brief.audience.trim(),
    purpose: brief.purpose.trim(),
    repositoryUrl: brief.repositoryUrl?.trim() || undefined,
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (brief.idea.trim().length < 10) return
    onSubmit(normalizedBrief())
  }

  return (
    <form className="brief-card" onSubmit={submit}>
      <div className="brief-heading">
        <div>
          <span className="eyebrow">New architecture story</span>
          <h2>What are you building?</h2>
          <p>Start with the idea. Optionally connect a GitHub codebase so Copilot can ground the story and architecture in code and docs.</p>
        </div>
        <span className="brief-step">01</span>
      </div>

      <label className="field field-wide">
        <span>Idea</span>
        <textarea
          value={brief.idea}
          onChange={event => update('idea', event.target.value)}
          placeholder="Example: An agent that turns a product idea into a story, architecture, demo narration, and polished video."
          rows={6}
          autoFocus
        />
      </label>


      <details className="brief-options">
        <summary>Optional details and codebase</summary>
        <div className="brief-grid">
          <label className="field">
            <span>Working title (optional)</span>
            <input
              value={brief.title}
              onChange={event => update('title', event.target.value)}
              placeholder="Presentation Agent"
            />
          </label>
          <label className="field">
            <span>Audience (optional)</span>
            <input
              value={brief.audience}
              onChange={event => update('audience', event.target.value)}
              placeholder="Product and engineering leaders"
            />
          </label>
        </div>

        <label className="field field-wide">
          <span>Purpose (optional)</span>
          <input
            value={brief.purpose}
            onChange={event => update('purpose', event.target.value)}
            placeholder="Align the team and secure approval for an MVP"
          />
        </label>

        <label className="field field-wide">
          <span>GitHub repository URL (optional)</span>
          <input
            type="url"
            value={brief.repositoryUrl || ''}
            onChange={event => update('repositoryUrl', event.target.value)}
            placeholder="https://github.com/owner/repository"
          />
        </label>
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
      </details>

      <div className="brief-actions">
        <span>Only the idea is required. Repository access is read-only.</span>
        <button className="primary-button" disabled={isLoading || brief.idea.trim().length < 10}>
          {isLoading ? 'Starting conversation...' : 'Start story'}
          <span aria-hidden="true">-&gt;</span>
        </button>
        {onQuickGenerate && (
          <button
            type="button"
            className="secondary-button"
            disabled={isLoading || brief.idea.trim().length < 10}
            onClick={() => onQuickGenerate(normalizedBrief())}
          >
            {isLoading ? 'Generating...' : 'Quick generate slides'}
          </button>
        )}
      </div>
    </form>
  )
}
