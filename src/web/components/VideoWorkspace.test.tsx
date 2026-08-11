import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { VideoWorkspace } from './VideoWorkspace'

describe('VideoWorkspace', () => {
  it('supports direct video polishing without a presentation project', () => {
    render(<VideoWorkspace standalone />)

    expect(screen.getByText('Start directly / Video polish')).toBeInTheDocument()
    expect(screen.getByText(/Skip slide creation and upload a recording now/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Choose a demo recording/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create refined video' })).toBeDisabled()
  })
})
