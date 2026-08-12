import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ArchitectureCanvas } from './ArchitectureCanvas'
import type { ArchitectureGraph } from '../types'

const architecture: ArchitectureGraph = {
  title: 'Presentation Agent Architecture',
  summary: 'Copilot structures an idea into a browser-rendered graph.',
  layers: [
    {
      id: 'experience',
      label: 'Experience',
      purpose: 'User interaction',
      tone: 'navy',
      nodes: [
        {
          id: 'web',
          label: 'Web Workspace',
          description: 'Captures the idea.',
          kind: 'interface',
          technology: 'React',
          provenance: 'confirmed',
        },
      ],
    },
    {
      id: 'intelligence',
      label: 'Intelligence',
      purpose: 'Agent reasoning',
      tone: 'blue',
      nodes: [
        {
          id: 'copilot',
          label: 'Copilot Agent',
          description: 'Creates graph JSON.',
          kind: 'agent',
          technology: 'GitHub Copilot SDK',
          provenance: 'assumed',
        },
      ],
    },
  ],
  platforms: [
    {
      id: 'web-platform',
      label: 'Web Platform',
      description: 'Hosts the workspace.',
      technology: 'React',
      componentNodeIds: ['web'],
      provenance: 'confirmed',
    },
    {
      id: 'copilot-platform',
      label: 'GitHub Copilot',
      description: 'Hosts graph generation.',
      technology: 'GitHub Copilot SDK',
      componentNodeIds: ['copilot'],
      provenance: 'confirmed',
    },
  ],
  workflow: {
    actor: 'Presenter',
    goal: 'Generate an architecture',
    steps: [
      {
        id: 'submit-brief',
        order: 1,
        label: 'Submit brief',
        userAction: 'Provide the presentation context.',
        platformCalls: [{
          nodeId: 'web',
          action: 'capture context',
          mechanism: 'browser form',
          output: 'approved context',
        }],
      },
      {
        id: 'generate-graph',
        order: 2,
        label: 'Generate graph',
        userAction: 'Request the architecture.',
        platformCalls: [{
          nodeId: 'copilot',
          action: 'generate graph',
          mechanism: 'Copilot SDK',
          output: 'architecture JSON',
        }],
      },
    ],
  },
  connections: [{
    from: 'web',
    to: 'copilot',
    label: 'request architecture',
    type: 'request',
    mechanism: 'HTTPS JSON',
    payload: 'approved context',
    provenance: 'confirmed',
    primary: true,
  }],
  assumptions: ['GitHub authentication is configured.'],
}

describe('ArchitectureCanvas', () => {
  it('renders architecture layers and nodes as HTML', () => {
    const { container } = render(
      <ArchitectureCanvas architecture={architecture} visual={null} isLoading={false} error={null} />,
    )

    expect(screen.getByText('Presentation Agent Architecture')).toBeInTheDocument()
    expect(screen.getByText('Experience')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Web Workspace' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Copilot Agent' })).toBeInTheDocument()
    expect(screen.getAllByText('React')).not.toHaveLength(0)
    expect(screen.getAllByText('GitHub Copilot SDK')).not.toHaveLength(0)
    expect(screen.getByText('Assumed')).toBeInTheDocument()
    expect(screen.getByText('Technical component interactions')).toBeInTheDocument()
    expect(screen.getByText('HTTPS JSON / approved context')).toBeInTheDocument()
    expect(container.querySelectorAll('.architecture-layer')).toHaveLength(2)
    expect(container.querySelectorAll('.architecture-node')).toHaveLength(2)
    expect(container.querySelector('.architecture-connectors')).toBeInTheDocument()
  })

  it('shows a loading state', () => {
    render(<ArchitectureCanvas architecture={null} visual={null} isLoading={true} error={null} />)
    expect(screen.getByText('Composing the system')).toBeInTheDocument()
  })

  it('renders Copilot-generated HTML in a sandbox', () => {
    render(
      <ArchitectureCanvas
        architecture={architecture}
        visual={{
          mode: 'html',
          htmlUrl: '/architecture.html',
        }}
        isLoading={false}
        error={null}
      />,
    )

    const frame = screen.getByTitle('Presentation Agent Architecture architecture diagram')
    expect(frame).toHaveAttribute('src', '/architecture.html')
    expect(frame).toHaveAttribute('sandbox')
    expect(screen.getByText('Creative / non-deterministic')).toBeInTheDocument()
  })

  it('switches between both generated architecture designs', () => {
    const onSelectedModeChange = vi.fn()
    render(
      <ArchitectureCanvas
        architecture={architecture}
        visual={{
          mode: 'dual',
          htmlUrl: '/architecture.html',
          validatedJsonHtmlUrl: '/architecture-validated-json.html',
          narrativeHtmlUrl: '/architecture-narrative.html',
          imageUrl: '/architecture.png',
          narrativeImageUrl: '/architecture-narrative.png',
        }}
        selectedMode="image"
        onSelectedModeChange={onSelectedModeChange}
        isLoading={false}
        error={null}
      />,
    )

    expect(screen.getByAltText(
      'Presentation Agent Architecture architecture design graph',
    )).toHaveAttribute('src', '/architecture.png')
    fireEvent.click(screen.getByRole('button', { name: 'Full context → HTML/CSS' }))
    expect(onSelectedModeChange).toHaveBeenCalledWith('html')
    fireEvent.click(screen.getByRole('button', { name: 'Agent narrative → image' }))
    expect(onSelectedModeChange).toHaveBeenCalledWith('narrative-image')
    fireEvent.click(screen.getByRole('button', { name: 'Agent narrative → HTML/CSS' }))
    expect(onSelectedModeChange).toHaveBeenCalledWith('narrative-html')
    fireEvent.click(screen.getByRole('button', {
      name: 'Validated JSON → Copilot HTML/CSS',
    }))
    expect(onSelectedModeChange).toHaveBeenCalledWith('validated-json-html')
  })
})
