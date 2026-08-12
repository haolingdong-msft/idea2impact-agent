import type { ArchitectureVisualMode } from '../types'

const OPTIONS: Array<{ mode: ArchitectureVisualMode; label: string }> = [
  { mode: 'html', label: 'Full context → HTML/CSS' },
  { mode: 'image', label: 'Validated JSON → image' },
  { mode: 'validated-json-html', label: 'Validated JSON → Copilot HTML/CSS' },
  { mode: 'narrative-image', label: 'Agent narrative → image' },
  { mode: 'narrative-html', label: 'Agent narrative → HTML/CSS' },
]

interface Props {
  selectedMode: ArchitectureVisualMode
  onSelectedModeChange?: (mode: ArchitectureVisualMode) => void
}

export function ArchitectureModeSwitcher({
  selectedMode,
  onSelectedModeChange,
}: Props) {
  return (
    <div className="architecture-mode-switcher" role="group" aria-label="Architecture visual">
      {OPTIONS.map(option => (
        <button
          type="button"
          className={selectedMode === option.mode ? 'active' : ''}
          onClick={() => onSelectedModeChange?.(option.mode)}
          key={option.mode}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
