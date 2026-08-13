import type { PresentationOutline } from '../types'

interface Props {
  outline: PresentationOutline | null
  isBusy: boolean
  isSaving: boolean
  error: string | null
  onChange: (outline: PresentationOutline) => void
  onApprove: () => void
  onGenerate: () => void
}

const SECTIONS: Array<{
  key: 'problemStatement' | 'userScenarios' | 'solution'
  number: string
  label: string
  help: string
}> = [
  {
    key: 'problemStatement',
    number: '01',
    label: 'Problem Statement',
    help: 'Users, pain, impact, scope, and desired outcome.',
  },
  {
    key: 'userScenarios',
    number: '02',
    label: 'User Scenarios',
    help: 'Actors, workflows, expected value, success, and edge cases.',
  },
  {
    key: 'solution',
    number: '03',
    label: 'Solution',
    help: 'Experience, capabilities, platforms, integrations, and constraints.',
  },
]

export function OutlineWorkspace({
  outline,
  isBusy,
  isSaving,
  error,
  onChange,
  onApprove,
  onGenerate,
}: Props) {
  const value = outline || {
    problemStatement: '',
    userScenarios: '',
    solution: '',
    status: 'draft' as const,
  }
  const complete = SECTIONS.every(section => value[section.key].trim().length >= 20)
  const approved = value.status === 'approved'

  return (
    <section className={`outline-workspace ${approved ? 'approved' : ''}`}>
      <header className="outline-heading">
        <div>
          <span className="eyebrow">Central outline / One source of truth</span>
          <h2>Shape the complete presentation story</h2>
          <p>
            Edit directly or answer Copilot in chat. All three sections stay synchronized
            and are approved together.
          </p>
        </div>
        <span className={`outline-status ${approved ? 'approved' : ''}`}>
          {approved ? 'Approved' : isSaving ? 'Saving...' : 'Draft autosaved'}
        </span>
      </header>

      <div className="outline-sections">
        {SECTIONS.map(section => (
          <label className="outline-section" key={section.key}>
            <span className="outline-section-number">{section.number}</span>
            <span className="outline-section-copy">
              <strong>{section.label}</strong>
              <small>{section.help}</small>
            </span>
            <textarea
              value={value[section.key]}
              readOnly={approved}
              rows={section.key === 'solution' ? 8 : 6}
              onChange={event => onChange({
                ...value,
                [section.key]: event.target.value,
                status: 'draft',
                approvedAt: undefined,
              })}
            />
          </label>
        ))}
      </div>

      {error && <p className="outline-error" role="alert">{error}</p>}
      <footer className="outline-actions">
        <span>
          {approved
            ? 'This approved revision now grounds architecture and slides.'
            : 'Approval locks the current revision for downstream generation.'}
        </span>
        {approved ? (
          <button type="button" onClick={onGenerate} disabled={isBusy}>
            {isBusy ? 'Generating slides...' : 'Generate slides + 3 designs'}
          </button>
        ) : (
          <button
            type="button"
            onClick={onApprove}
            disabled={!complete || isBusy || isSaving}
          >
            {isBusy ? 'Approving...' : 'Approve complete outline'}
          </button>
        )}
      </footer>
    </section>
  )
}
