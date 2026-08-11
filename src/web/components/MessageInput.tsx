import { useState, type FormEvent } from 'react'

interface Props {
  onSend: (message: string) => void
  disabled: boolean
}

export function MessageInput({ onSend, disabled }: Props) {
  const [value, setValue] = useState('')

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const trimmed = value.trim()
    if (!trimmed) return
    onSend(trimmed)
    setValue('')
  }

  return (
    <form className="input-form" onSubmit={handleSubmit}>
      <textarea
        value={value}
        onChange={e => setValue(e.target.value)}
        placeholder="Ask Copilot to refine the story or architecture..."
        autoFocus
        disabled={disabled}
        rows={2}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }
        }}
      />
      <button type="submit" aria-label="Send message" disabled={disabled || !value.trim()}>
        -&gt;
      </button>
    </form>
  )
}
