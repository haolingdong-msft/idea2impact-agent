import type { ArchitectureVisualMode } from '../types'

const OPTIONS: Array<{ mode: ArchitectureVisualMode; label: string }> = [
  { mode: 'image', label: 'Validated JSON → GPT-Image-2' },
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
    <div className="architecture-mode-switcher" role="group" aria-label="Overview visual">
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
