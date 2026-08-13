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
    await user.click(screen.getByRole('button', { name: /start outline/i }))

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
    await user.click(screen.getByRole('button', { name: /start outline/i }))

    expect(onSubmit.mock.calls[0][0].repositoryUrl).toBe(
      'https://github.com/example/repository',
    )
  })

  it('enables codebase quick test only after a repository URL is entered', async () => {
    const user = userEvent.setup()
    const onQuickTest = vi.fn()
    render(
      <IdeaBrief
        isLoading={false}
        onSubmit={vi.fn()}
        onQuickTest={onQuickTest}
      />,
    )
    await user.type(
      screen.getByLabelText('Idea'),
      'Generate slides directly from this codebase for a quick test.',
    )
    const quickButton = screen.getByRole('button', {
      name: /quick test: generate slides/i,
    })
    expect(quickButton).toBeDisabled()
    await user.click(screen.getByText('Optional details and codebase'))
    await user.type(
      screen.getByLabelText('GitHub repository URL (optional)'),
      'https://github.com/example/repository',
    )
    expect(quickButton).toBeEnabled()
    await user.click(quickButton)
    expect(onQuickTest).toHaveBeenCalledWith(expect.objectContaining({
      repositoryUrl: 'https://github.com/example/repository',
    }))
  })
})
