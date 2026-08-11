import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { IdeaBrief } from './IdeaBrief'

describe('IdeaBrief', () => {
  it('submits with only the required idea', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<IdeaBrief isLoading={false} onSubmit={onSubmit} />)

    await user.type(
      screen.getByLabelText('Idea'),
      'Create technical architecture slides from an idea.',
    )
    await user.click(screen.getByRole('button', { name: /start story/i }))

    expect(onSubmit).toHaveBeenCalledWith({
      title: 'Untitled presentation',
      idea: 'Create technical architecture slides from an idea.',
      audience: '',
      purpose: '',
      repositoryUrl: undefined,
    })
  })

  it('accepts an optional GitHub repository URL', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<IdeaBrief isLoading={false} onSubmit={onSubmit} />)

    await user.type(
      screen.getByLabelText('Idea'),
      'Explain the architecture implemented by this repository.',
    )
    await user.click(screen.getByText('Optional details and codebase'))
    await user.type(
      screen.getByLabelText('GitHub repository URL (optional)'),
      'https://github.com/example/repository',
    )
    await user.click(screen.getByRole('button', { name: /start story/i }))

    expect(onSubmit.mock.calls[0][0].repositoryUrl).toBe(
      'https://github.com/example/repository',
    )
  })
})
