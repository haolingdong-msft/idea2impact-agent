import { useState, type FormEvent } from 'react'

interface Props {
  onSend: (message: string) => void
  disabled: boolean
  placeholder?: string
}

export function MessageInput({
  onSend,
  disabled,
  placeholder = 'Ask Copilot to refine the story or overview...',
}: Props) {
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
        placeholder={placeholder}
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
