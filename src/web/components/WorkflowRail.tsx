const STEPS = [
  ['01', 'Start story'],
  ['02', 'Generate overview image'],
  ['03', 'Generate slides'],
  ['04', 'Generate video'],
]

type Props = {
  activeStep: number
  selectedStep: number
  onSelect: (step: number) => void
}

export function WorkflowRail({ activeStep, selectedStep, onSelect }: Props) {
  return (
    <nav className="workflow-rail" aria-label="Presentation workflow">
      <span className="rail-label">Workflow</span>
      {STEPS.map(([number, label], index) => {
        const status = index < activeStep ? 'complete' : index === activeStep ? 'active' : 'upcoming'
        return (
          <button
            type="button"
            className={`rail-step ${status}${index === selectedStep ? ' selected' : ''}`}
            key={number}
            onClick={() => onSelect(index)}
            aria-pressed={index === selectedStep}
          >
            <span className="rail-number">{status === 'complete' ? 'OK' : number}</span>
            <span>{label}</span>
          </button>
        )
      })}
    </nav>
  )
}
