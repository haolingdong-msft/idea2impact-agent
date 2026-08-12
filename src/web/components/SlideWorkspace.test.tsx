import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SlideWorkspace } from './SlideWorkspace'
import type {
  ArchitectureGraph,
  SlideGenerationResult,
} from '../types'

const architecture: ArchitectureGraph = {
  title: 'Presentation Agent Architecture',
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
    title: 'Presentation Agent',
    subtitle: 'One project.',
    theme: 'azure',
    slides: [
      {
        id: 'opening',
        kind: 'title',
        eyebrow: 'Presentation Agent',
        title: 'Build the story once',
        subtitle: 'Carry context forward.',
        bullets: [],
      },
      {
        id: 'architecture',
        kind: 'architecture',
        eyebrow: 'Architecture',
        title: 'One orchestrated workspace',
        subtitle: '',
        bullets: [],
      },
    ],
  },
  previewUrl: '/preview',
  downloadUrl: '/download',
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

    fireEvent.click(screen.getByRole('button', { name: 'Generate slides + 5 designs' }))
    expect(onGenerate).toHaveBeenCalledOnce()
  })

  it('previews generated slides and architecture as HTML', () => {
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
      name: 'Show slide 2: One orchestrated workspace',
    }))
    expect(screen.getByText('Web Workspace')).toBeInTheDocument()
    expect(screen.getByText('GitHub Copilot SDK')).toBeInTheDocument()
    expect(screen.getByText('HTTPS JSON / approved story')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Download HTML' })).toHaveAttribute(
      'href',
      '/download',
    )
    expect(container.querySelector('svg')).not.toBeInTheDocument()
  })

  it('shows all five generated architecture choices for slides', () => {
    const onArchitectureModeChange = vi.fn()
    render(
      <SlideWorkspace
        architecture={architecture}
        visual={{
          mode: 'dual',
          htmlUrl: '/architecture.html',
          validatedJsonHtmlUrl: '/architecture-validated-json.html',
          imageUrl: '/architecture.png',
          narrativeImageUrl: '/architecture-narrative.png',
          narrativeHtmlUrl: '/architecture-narrative.html',
        }}
        architectureMode="image"
        onArchitectureModeChange={onArchitectureModeChange}
        result={null}
        isGenerating={false}
        error={null}
        onGenerate={vi.fn()}
      />,
    )

    expect(screen.getByText('All five were generated. The selected design is used by the deck.'))
      .toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Agent narrative → HTML/CSS' }))
    expect(onArchitectureModeChange).toHaveBeenCalledWith('narrative-html')
    fireEvent.click(screen.getByRole('button', {
      name: 'Validated JSON → Copilot HTML/CSS',
    }))
    expect(onArchitectureModeChange).toHaveBeenCalledWith('validated-json-html')
  })
})
