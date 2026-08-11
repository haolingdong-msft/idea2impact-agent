const STEPS = [
  ['01', 'Describe idea'],
  ['02', 'Structure story'],
  ['03', 'Architecture'],
  ['04', 'Generate slides'],
  ['05', 'Upload recording'],
  ['06', 'Polish video'],
  ['07', 'Speech script'],
  ['08', 'Narration'],
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
            {index > 4 && <small>Later</small>}
          </div>
        )
      })}
    </nav>
  )
}
