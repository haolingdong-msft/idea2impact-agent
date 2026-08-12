import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { StorySection } from '../types'
import { StoryApproval } from './StoryApproval'

describe('StoryApproval', () => {
  it('enforces sequential approval', () => {
    const onApprove = vi.fn()
    render(
      <StoryApproval
        approved={[]}
        canApprove
        isGenerating={false}
        onApprove={onApprove}
        onGenerate={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: /Problem statement/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /User story/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /Problem statement/ }))
    expect(onApprove).toHaveBeenCalledWith('problem')
  })

  it('enables generation only after all sections are approved', () => {
    const onGenerate = vi.fn()
    render(
      <StoryApproval
        approved={['problem', 'userStory', 'architecture']}
        canApprove
        isGenerating={false}
        onApprove={vi.fn()}
        onGenerate={onGenerate}
      />,
    )

    const generateButton = screen.getByRole('button', {
      name: 'Generate slides',
    })
    expect(generateButton).toBeEnabled()
    fireEvent.click(generateButton)
    expect(onGenerate).toHaveBeenCalledOnce()
  })

  it('progresses through all gates and executes generation', () => {
    const onGenerate = vi.fn()

    function ApprovalHarness() {
      const [approved, setApproved] = useState<StorySection[]>([])
      return (
        <StoryApproval
          approved={approved}
          canApprove
          isGenerating={false}
          onApprove={section => setApproved(current => [...current, section])}
          onGenerate={onGenerate}
        />
      )
    }

    render(<ApprovalHarness />)
    fireEvent.click(screen.getByRole('button', { name: /Problem statement/ }))
    fireEvent.click(screen.getByRole('button', { name: /User story/ }))
    fireEvent.click(screen.getByRole('button', { name: /Architecture/ }))

    expect(screen.getByText('3/3')).toBeInTheDocument()
    const generateButton = screen.getByRole('button', {
      name: 'Generate slides',
    })
    expect(generateButton).toBeEnabled()
    fireEvent.click(generateButton)
    expect(onGenerate).toHaveBeenCalledOnce()
  })

  it('allows direct part updates after a deck exists', () => {
    const onGenerate = vi.fn()
    render(
      <StoryApproval
        approved={['problem', 'userStory', 'architecture']}
        canApprove={false}
        isGenerating={false}
        isRefining
        onApprove={vi.fn()}
        onGenerate={onGenerate}
      />,
    )

    expect(screen.getByText('Update any part in chat')).toBeInTheDocument()
    expect(screen.queryByText('Confirm the story before drawing')).not.toBeInTheDocument()
    const applyButton = screen.getByRole('button', {
      name: 'Apply updates to slides',
    })
    expect(applyButton).toBeEnabled()
    fireEvent.click(applyButton)
    expect(onGenerate).toHaveBeenCalledOnce()
  })
})
