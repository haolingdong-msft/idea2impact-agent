import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SpeechWorkspace } from './SpeechWorkspace'

describe('SpeechWorkspace', () => {
  it('generates notes only after slides and allows editing', () => {
    const onGenerate = vi.fn()
    const { rerender } = render(
      <SpeechWorkspace
        script={null}
        isGenerating={false}
        isSaving={false}
        error={null}
        onGenerate={onGenerate}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /generate speech script/i }))
    expect(onGenerate).toHaveBeenCalledOnce()

    const onChange = vi.fn()
    rerender(
      <SpeechWorkspace
        script={{
          title: 'Speaker notes',
          notes: [{
            slideId: 'problem',
            slideTitle: 'The problem',
            script: 'Explain why manual presentation handoffs lose important context.',
          }],
        }}
        isGenerating={false}
        isSaving={false}
        error={null}
        onGenerate={onGenerate}
        onChange={onChange}
        onSave={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Updated grounded speaker note for this slide.' },
    })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      notes: [expect.objectContaining({
        script: 'Updated grounded speaker note for this slide.',
      })],
    }))
    expect(screen.getByText(/does not synthesize audio/i)).toBeInTheDocument()
  })
})
