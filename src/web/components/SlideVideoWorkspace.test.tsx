import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SlideVideoWorkspace } from './SlideVideoWorkspace'

describe('SlideVideoWorkspace', () => {
  it('exposes HTML slides, total duration, scripts, and video planning on the start page', () => {
    render(<SlideVideoWorkspace />)

    expect(screen.getByText('Step 04 / Generate video')).toBeInTheDocument()
    expect(screen.getByLabelText(/Choose an HTML slide deck/)).toHaveAttribute(
      'accept',
      'text/html,.html,.htm',
    )
    expect(screen.getByDisplayValue('90')).toHaveAttribute('type', 'number')
    expect(screen.getByRole('button', { name: 'Generate video plan' })).toBeDisabled()
  })

  it('automatically plans video from a generated slide deck URL', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        '<html><section class="slide"></section></html>',
        {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        jobId: 'video-job',
        title: 'Generated deck',
        targetDurationSeconds: 90,
        slides: [{
          slideId: 'problem',
          slideTitle: 'Problem',
          script: 'A complete narration script for this generated slide.',
          durationSeconds: 90,
        }],
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    render(
      <SlideVideoWorkspace
        sourceUrl="/projects/project-id/slides/download"
        sourceName="Generated value deck"
        autoStart
      />,
    )

    expect(screen.getByText('Generated value deck')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByText('1 slides detected')).toBeInTheDocument(),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/projects/project-id/slides/download',
    )
    expect(fetchMock.mock.calls[1][0]).toBe(
      '/slide-video/plan?targetDurationSeconds=90',
    )
    vi.unstubAllGlobals()
  })
})
