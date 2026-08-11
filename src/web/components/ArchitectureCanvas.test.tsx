import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
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
      <ArchitectureCanvas architecture={architecture} isLoading={false} error={null} />,
    )

    expect(screen.getByText('Presentation Agent Architecture')).toBeInTheDocument()
    expect(screen.getByText('Experience')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Web Workspace' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Copilot Agent' })).toBeInTheDocument()
    expect(screen.getByText('React')).toBeInTheDocument()
    expect(screen.getByText('GitHub Copilot SDK')).toBeInTheDocument()
    expect(screen.getByText('Assumed')).toBeInTheDocument()
    expect(screen.getByText('Technical component interactions')).toBeInTheDocument()
    expect(screen.getByText('HTTPS JSON / approved context')).toBeInTheDocument()
    expect(container.querySelectorAll('.architecture-layer')).toHaveLength(2)
    expect(container.querySelectorAll('.architecture-node')).toHaveLength(2)
    expect(container.querySelector('.architecture-connectors')).toBeInTheDocument()
  })

  it('shows a loading state', () => {
    render(<ArchitectureCanvas architecture={null} isLoading={true} error={null} />)
    expect(screen.getByText('Composing the system')).toBeInTheDocument()
  })
})
