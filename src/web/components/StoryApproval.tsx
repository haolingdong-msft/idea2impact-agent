import type { StorySection } from '../types'

const SECTIONS: Array<{ id: StorySection; label: string; detail: string }> = [
  { id: 'problem', label: 'Problem statement', detail: 'Pain, impact, scope, and outcome' },
  { id: 'userStory', label: 'User story', detail: 'Persona, journey, value, and success' },
  { id: 'architecture', label: 'Architecture', detail: 'Boundaries, components, flow, and constraints' },
]

interface Props {
  approved: StorySection[]
  canApprove: boolean
  isGenerating: boolean
  onApprove: (section: StorySection) => void
  onGenerate: () => void
}

export function StoryApproval({
  approved,
  canApprove,
  isGenerating,
  onApprove,
  onGenerate,
}: Props) {
  const allApproved = SECTIONS.every(section => approved.includes(section.id))

  return (
    <section className="story-approval" aria-label="Story approval gates">
      <div className="approval-heading">
        <div>
          <span className="eyebrow">Approval gates</span>
          <strong>Confirm the story before drawing</strong>
        </div>
        <span>{approved.length}/3</span>
      </div>
      <div className="approval-list">
        {SECTIONS.map((section, index) => {
          const isApproved = approved.includes(section.id)
          const previousApproved = index === 0 || approved.includes(SECTIONS[index - 1].id)
          return (
            <button
              type="button"
              className={isApproved ? 'approved' : ''}
              disabled={isApproved || !canApprove || !previousApproved}
              onClick={() => onApprove(section.id)}
              key={section.id}
            >
              <span>{isApproved ? 'OK' : `0${index + 1}`}</span>
              <div>
                <strong>{section.label}</strong>
                <small>{section.detail}</small>
              </div>
            </button>
          )
        })}
      </div>
      <button
        type="button"
        className="generate-button"
        disabled={!allApproved || !canApprove || isGenerating}
        onClick={onGenerate}
      >
        {isGenerating ? 'Generating slides...' : 'Generate slides'}
      </button>
    </section>
  )
}
