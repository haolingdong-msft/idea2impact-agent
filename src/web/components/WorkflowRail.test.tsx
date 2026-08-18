import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WorkflowRail } from './WorkflowRail'

describe('WorkflowRail', () => {
  it('shows four clickable workflow stages', () => {
    const onSelect = vi.fn()
    render(<WorkflowRail activeStep={1} selectedStep={0} onSelect={onSelect} />)

    expect(screen.getAllByRole('button')).toHaveLength(4)
    fireEvent.click(screen.getByRole('button', { name: /Generate slides/ }))
    expect(onSelect).toHaveBeenCalledWith(2)
  })
})
