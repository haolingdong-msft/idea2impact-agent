import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { OutlineWorkspace } from './OutlineWorkspace'

const outline = {
  problemStatement: 'Teams lose time recreating approved presentation context.',
  userScenarios: 'Presenters refine one outline through direct edits and agent chat.',
  solution: 'A Copilot workflow generates architecture, slides, and speaker notes.',
  status: 'draft' as const,
}

describe('OutlineWorkspace', () => {
  it('supports direct edits and one combined approval', () => {
    const onChange = vi.fn()
    const onApprove = vi.fn()
    render(
      <OutlineWorkspace
        outline={outline}
        isBusy={false}
        isGeneratingOutline={false}
        isApproving={false}
        isSaving={false}
        error={null}
        isGeneratingOverview={false}
        onChange={onChange}
        onApprove={onApprove}
        onGenerateOverview={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByLabelText(/Problem Statement/), {
      target: { value: 'A revised problem statement with enough useful detail.' },
    })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      problemStatement: 'A revised problem statement with enough useful detail.',
      status: 'draft',
    }))
    fireEvent.click(screen.getByRole('button', { name: /complete story/i }))
    expect(onApprove).toHaveBeenCalledOnce()
  })

  it('locks the approved revision and exposes generation', () => {
    const onGenerateOverview = vi.fn()
    render(
      <OutlineWorkspace
        outline={{ ...outline, status: 'approved', approvedAt: '2026-08-11T00:00:00Z' }}
        isBusy={false}
        isGeneratingOutline={false}
        isApproving={false}
        isSaving={false}
        error={null}
        isGeneratingOverview={false}
        onChange={vi.fn()}
        onApprove={vi.fn()}
        onGenerateOverview={onGenerateOverview}
      />,
    )
    expect(screen.getAllByRole('textbox')[0]).toHaveAttribute('readonly')
    fireEvent.click(screen.getByRole('button', { name: /generate overview image/i }))
    expect(onGenerateOverview).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: /generate slides/i }))
      .not.toBeInTheDocument()
  })

  it('distinguishes outline generation from approval', () => {
    const { rerender } = render(
      <OutlineWorkspace
        outline={outline}
        isBusy
        isGeneratingOutline
        isApproving={false}
        isSaving={false}
        error={null}
        isGeneratingOverview={false}
        onChange={vi.fn()}
        onApprove={vi.fn()}
        onGenerateOverview={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Generating outline...' }))
      .toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Approving...' }))
      .not.toBeInTheDocument()

    rerender(
      <OutlineWorkspace
        outline={outline}
        isBusy
        isGeneratingOutline={false}
        isApproving
        isSaving={false}
        error={null}
        isGeneratingOverview={false}
        onChange={vi.fn()}
        onApprove={vi.fn()}
        onGenerateOverview={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Approving...' })).toBeDisabled()
  })
})
