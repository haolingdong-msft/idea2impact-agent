import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { IdeaBrief } from './IdeaBrief'

describe('IdeaBrief', () => {
  it('notifies the parent to clear a stale error when the user edits', async () => {
    const user = userEvent.setup()
    const onEdit = vi.fn()
    render(<IdeaBrief isLoading={false} onSubmit={vi.fn()} onEdit={onEdit} />)

    await user.type(screen.getByLabelText('1. Idea'), 'a')

    expect(onEdit).toHaveBeenCalled()
  })

  it('allows a short non-empty idea for manual smoke testing', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<IdeaBrief isLoading={false} onSubmit={onSubmit} />)

    await user.type(screen.getByLabelText('1. Idea'), 'test')
    await user.click(screen.getByRole('button', { name: /start story/i }))

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      idea: 'test',
    }))
  })

  it('submits with only the required idea', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<IdeaBrief isLoading={false} onSubmit={onSubmit} />)

    await user.type(
      screen.getByLabelText('1. Idea'),
      'Create technical architecture slides from an idea.',
    )
    await user.click(screen.getByRole('button', { name: /start story/i }))

    expect(onSubmit).toHaveBeenCalledWith({
      title: 'Turn your idea into a story people remember',
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
      screen.getByLabelText('1. Idea'),
      'Explain the architecture implemented by this repository.',
    )
    await user.type(
      screen.getByLabelText(/GitHub repository link/),
      'https://github.com/example/repository',
    )
    await user.click(screen.getByRole('button', { name: /start story/i }))

    expect(onSubmit.mock.calls[0][0].repositoryUrl).toBe(
      'https://github.com/example/repository',
    )
    expect(screen.queryByLabelText(/Working title|Audience|Purpose/))
      .not.toBeInTheDocument()
  })

})
