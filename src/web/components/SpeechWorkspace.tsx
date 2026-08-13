import type { SpeechScript } from '../types'

interface Props {
  script: SpeechScript | null
  isGenerating: boolean
  isSaving: boolean
  error: string | null
  onGenerate: () => void
  onChange: (script: SpeechScript) => void
  onSave: () => void
}

export function SpeechWorkspace({
  script,
  isGenerating,
  isSaving,
  error,
  onGenerate,
  onChange,
  onSave,
}: Props) {
  return (
    <section className="speech-workspace" aria-labelledby="speech-workspace-title">
      <header>
        <div>
          <span className="eyebrow">Step 06 / Generate speech</span>
          <h2 id="speech-workspace-title">Create speaker notes from the slides</h2>
          <p>
            Copilot turns each slide into an editable spoken script. This step creates
            notes only; it does not synthesize audio.
          </p>
        </div>
        {script && <span className="asset-badge">Stored with slide lineage</span>}
      </header>

      {!script ? (
        <div className="speech-empty">
          <div>
            <strong>Ready to draft the talk track</strong>
            <p>Every generated slide receives one grounded speaker-note segment.</p>
          </div>
          <button type="button" onClick={onGenerate} disabled={isGenerating}>
            {isGenerating ? 'Generating speaker notes...' : 'Generate speech script'}
          </button>
        </div>
      ) : (
        <div className="speech-notes">
          {script.notes.map((note, index) => (
            <label key={note.slideId}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <div>
                <strong>{note.slideTitle}</strong>
                <textarea
                  rows={6}
                  value={note.script}
                  onChange={event => onChange({
                    ...script,
                    notes: script.notes.map(candidate =>
                      candidate.slideId === note.slideId
                        ? { ...candidate, script: event.target.value }
                        : candidate),
                  })}
                />
              </div>
            </label>
          ))}
          <button type="button" onClick={onSave} disabled={isSaving}>
            {isSaving ? 'Saving script...' : 'Save speech script'}
          </button>
        </div>
      )}
      {error && <p className="outline-error" role="alert">{error}</p>}
    </section>
  )
}
