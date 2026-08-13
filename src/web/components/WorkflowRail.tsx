const STEPS = [
  ['01', 'Describe idea'],
  ['02', 'Refine outline'],
  ['03', 'Review summary'],
  ['04', 'Approve outline'],
  ['05', 'Generate slides'],
  ['06', 'Generate speech'],
  ['07', 'Upload recording'],
  ['08', 'Refine recording'],
]

export function WorkflowRail({ activeStep }: { activeStep: number }) {
  return (
    <nav className="workflow-rail" aria-label="Presentation workflow">
      <span className="rail-label">Workflow</span>
      {STEPS.map(([number, label], index) => {
        const status = index < activeStep ? 'complete' : index === activeStep ? 'active' : 'upcoming'
        return (
          <div className={`rail-step ${status}`} key={number}>
            <span className="rail-number">{status === 'complete' ? 'OK' : number}</span>
            <span>{label}</span>
          </div>
        )
      })}
    </nav>
  )
}
