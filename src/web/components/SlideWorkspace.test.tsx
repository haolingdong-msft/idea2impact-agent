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
        result={null}
        isGenerating={false}
        error={null}
        onGenerate={onGenerate}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Generate HTML slides' }))
    expect(onGenerate).toHaveBeenCalledOnce()
  })

  it('previews generated slides and architecture as HTML', () => {
    const { container } = render(
      <SlideWorkspace
        architecture={architecture}
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
})
