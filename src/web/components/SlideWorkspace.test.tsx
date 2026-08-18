import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SlideWorkspace } from './SlideWorkspace'
import type {
  ArchitectureGraph,
  SlideGenerationResult,
} from '../types'

const architecture: ArchitectureGraph = {
  title: 'Idea2Impact Agent Architecture',
  summary: 'A guided workflow.',
  layers: [{
    id: 'experience',
    label: 'Experience',
    purpose: 'Guides the presenter.',
    tone: 'navy',
    nodes: [{
      id: 'workspace',
      label: 'Web Workspace',
      description: 'Hosts the workflow.',
      kind: 'interface',
      technology: 'React',
      provenance: 'confirmed',
    }],
  }, {
    id: 'agent',
    label: 'Agent',
    purpose: 'Generates artifacts.',
    tone: 'blue',
    nodes: [{
      id: 'copilot',
      label: 'Copilot SDK',
      description: 'Generates architecture and slides.',
      kind: 'agent',
      technology: 'GitHub Copilot SDK',
      provenance: 'confirmed',
    }],
  }],
  platforms: [
    {
      id: 'web-platform',
      label: 'Web Platform',
      description: 'Hosts the workspace.',
      technology: 'React',
      componentNodeIds: ['workspace'],
      provenance: 'confirmed',
    },
    {
      id: 'copilot-platform',
      label: 'GitHub Copilot',
      description: 'Hosts generation.',
      technology: 'GitHub Copilot SDK',
      componentNodeIds: ['copilot'],
      provenance: 'confirmed',
    },
  ],
  workflow: {
    actor: 'Presenter',
    goal: 'Generate a slide deck',
    steps: [
      {
        id: 'approve-story',
        order: 1,
        label: 'Approve story',
        userAction: 'Review and approve the story.',
        platformCalls: [{
          platformId: 'web-platform',
          toolingId: 'workspace',
          nodeId: 'workspace',
          action: 'capture approval',
          mechanism: 'React UI',
          output: 'approved story',
        }],
      },
      {
        id: 'generate-slides',
        order: 2,
        label: 'Generate slides',
        userAction: 'Request the final deck.',
        platformCalls: [{
          platformId: 'copilot-platform',
          toolingId: 'copilot',
          nodeId: 'copilot',
          action: 'generate deck',
          mechanism: 'Copilot SDK',
          output: 'slide deck',
        }],
      },
    ],
  },
  connections: [{
    from: 'workspace',
    to: 'copilot',
    label: 'generate presentation',
    type: 'request',
    mechanism: 'HTTPS JSON',
    payload: 'approved story',
    provenance: 'confirmed',
    primary: true,
  }],
  assumptions: [],
}

const result: SlideGenerationResult = {
  deck: {
    title: 'Idea2Impact Agent',
    subtitle: 'One project.',
    theme: 'azure',
    slides: [
      {
        id: 'problem',
        kind: 'problem',
        eyebrow: 'Problem',
        title: 'Presentation work is fragmented',
        subtitle: '',
        bullets: ['Teams repeat the same approved context.'],
        imageUrl: '/slides/problem/image',
      },
      {
        id: 'user-scenarios',
        kind: 'user-scenarios',
        eyebrow: 'User scenarios',
        title: 'One guided workflow',
        subtitle: '',
        bullets: ['Presenters create assets from one brief.'],
        imageUrl: '/slides/user-scenarios/image',
      },
      {
        id: 'solution',
        kind: 'solution',
        eyebrow: 'Solution',
        title: 'A synchronized Idea2Impact Agent',
        subtitle: '',
        bullets: ['Generated assets preserve approved context.'],
        imageUrl: '/slides/solution/image',
      },
    ],
  },
  previewUrl: '/preview',
  downloadUrl: '/download',
  pptxDownloadUrl: '/download.pptx',
  pptxGenerateUrl: '/generate-editable-pptx',
}

describe('SlideWorkspace', () => {
  it('offers slide generation from an approved architecture', () => {
    const onGenerate = vi.fn()
    render(
      <SlideWorkspace
        architecture={architecture}
        visual={null}
        result={null}
        isGenerating={false}
        error={null}
        onGenerate={onGenerate}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Generate slides' }))
    expect(onGenerate).toHaveBeenCalledOnce()
  })

  it('shows percentage progress and the current slide-generation action', () => {
    render(
      <SlideWorkspace
        architecture={architecture}
        visual={null}
        result={null}
        progress={{
          status: 'running',
          percent: 52,
          stage: 'Generating visuals',
          log: 'Finished visual 2/4: One guided workflow',
          completedSlides: 2,
          totalSlides: 4,
        }}
        isGenerating
        error={null}
        onGenerate={vi.fn()}
      />,
    )

    expect(screen.getByRole('progressbar', {
      name: 'Slide generation progress',
    })).toHaveAttribute('value', '52')
    expect(screen.getByText('52%')).toBeInTheDocument()
    expect(screen.getByText(
      'Finished visual 2/4: One guided workflow',
    )).toBeInTheDocument()
  })

  it('previews full-slide images and exposes direct downloads', () => {
    const { container } = render(
      <SlideWorkspace
        architecture={architecture}
        visual={null}
        result={result}
        isGenerating={false}
        error={null}
        onGenerate={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', {
      name: 'Show slide 2: One guided workflow',
    }))
    expect(screen.getByRole('img', { name: 'One guided workflow illustration' }))
      .toHaveAttribute('src', '/slides/user-scenarios/image')
    expect(container.querySelector('.slide-preview.has-story-image')).not.toBeNull()
    expect(container.querySelector('.slide-story-image > img')).not.toBeNull()
    expect(container.querySelector('.slide-story-layout > ul')).toBeNull()
    expect(screen.getByRole('link', { name: 'Download HTML' })).toHaveAttribute(
      'href',
      '/download',
    )
    expect(screen.getByRole('link', { name: 'Download PPTX' })).toHaveAttribute(
      'href',
      '/download.pptx',
    )
    expect(screen.queryByText('Generate editable slides with skill'))
      .not.toBeInTheDocument()
    expect(container.querySelector('svg')).not.toBeInTheDocument()
  })

  it('offers video creation after slides are generated', () => {
    const onCreateVideo = vi.fn()
    render(
      <SlideWorkspace
        architecture={architecture}
        visual={null}
        result={result}
        isGenerating={false}
        error={null}
        onGenerate={vi.fn()}
        onCreateVideo={onCreateVideo}
      />,
    )

    fireEvent.click(screen.getByRole('button', {
      name: 'Generate video',
    }))
    expect(onCreateVideo).toHaveBeenCalledOnce()
  })

  it('does not show obsolete architecture design choices', () => {
    render(
      <SlideWorkspace
        architecture={architecture}
        visual={{
          mode: 'image',
          imageUrl: '/architecture.png',
        }}
        architectureMode="image"
        result={null}
        isGenerating={false}
        error={null}
        onGenerate={vi.fn()}
      />,
    )

    expect(screen.queryByText('All three were generated. The selected design is used by the deck.'))
      .not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'GPT-Image-2 → HTML/CSS' }))
      .not.toBeInTheDocument()
  })
})
