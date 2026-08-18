import type { PresentationOutline } from '../types'

interface Props {
  outline: PresentationOutline | null
  isBusy: boolean
  isGeneratingOutline: boolean
  isApproving: boolean
  isSaving: boolean
  error: string | null
  isGeneratingOverview: boolean
  onChange: (outline: PresentationOutline) => void
  onApprove: () => void
  onGenerateOverview: () => void
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
    help: 'Platforms, key tooling/components, high-level connections, capabilities, and constraints.',
  },
]

export function OutlineWorkspace({
  outline,
  isBusy,
  isGeneratingOutline,
  isApproving,
  isSaving,
  error,
  isGeneratingOverview,
  onChange,
  onApprove,
  onGenerateOverview,
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
          <span className="eyebrow">Step 01 / Start story</span>
          <h2>Shape the complete story</h2>
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
            ? 'This approved revision now grounds the overview and slides.'
            : 'Approval locks the current revision for downstream generation.'}
        </span>
        {approved ? (
          <button
            type="button"
            onClick={onGenerateOverview}
            disabled={isBusy}
          >
            {isGeneratingOverview ? 'Generating overview image...' : 'Generate overview image'}
          </button>
        ) : (
          <button
            type="button"
            onClick={onApprove}
            disabled={!complete || isBusy || isSaving}
          >
            {isApproving
              ? 'Approving...'
              : isGeneratingOutline
                ? 'Generating outline...'
                : 'Complete story'}
          </button>
        )}
      </footer>
    </section>
  )
}
