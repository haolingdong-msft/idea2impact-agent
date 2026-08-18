import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ArchitectureCanvas, EditablePptQuickTest } from './ArchitectureCanvas'
import type { ArchitectureGraph } from '../types'

const architecture: ArchitectureGraph = {
  title: 'Idea2Impact Agent Architecture',
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
      toolings: [{
        id: 'brief-capture',
        label: 'Brief capture',
        description: 'Captures presentation context.',
        technology: 'React form',
        componentNodeId: 'web',
      }],
      provenance: 'confirmed',
    },
    {
      id: 'copilot-platform',
      label: 'GitHub Copilot',
      description: 'Hosts graph generation.',
      technology: 'GitHub Copilot SDK',
      componentNodeIds: ['copilot'],
      toolings: [{
        id: 'graph-generation',
        label: 'Graph generation',
        description: 'Generates architecture JSON.',
        technology: 'GitHub Copilot SDK',
        componentNodeId: 'copilot',
      }],
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
          platformId: 'web-platform',
          toolingId: 'brief-capture',
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
          platformId: 'copilot-platform',
          toolingId: 'graph-generation',
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

    expect(screen.getByText('Idea2Impact Agent Architecture')).toBeInTheDocument()
    expect(screen.getByText('Experience')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Web Workspace' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Copilot Agent' })).toBeInTheDocument()
    expect(screen.getAllByText('React')).not.toHaveLength(0)
    expect(screen.getAllByText('GitHub Copilot SDK')).not.toHaveLength(0)
    expect(screen.getByText('Assumed')).toBeInTheDocument()
    expect(screen.getByText('Technical component interactions')).toBeInTheDocument()
    expect(screen.getByText('User workflow · Presenter')).toBeInTheDocument()
    expect(screen.getAllByText('Web Platform → Brief capture')).not.toHaveLength(0)
    expect(screen.getAllByText('GitHub Copilot → Graph generation')).not.toHaveLength(0)
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

    const frame = screen.getByTitle('Idea2Impact Agent Architecture overview diagram')
    expect(frame).toHaveAttribute('src', '/architecture.html')
    expect(frame).toHaveAttribute('sandbox')
    expect(screen.getByText('Creative / non-deterministic')).toBeInTheDocument()
  })

  it('shows the overview image without an editable PPT action', () => {
    render(
      <ArchitectureCanvas
        architecture={architecture}
        visual={{
          mode: 'image',
          imageUrl: '/architecture.png',
          pptxDownloadUrl: '/architecture.pptx',
          pptxGenerateUrl: '/architecture/generate-editable-pptx',
        }}
        selectedMode="image"
        isLoading={false}
        error={null}
      />,
    )

    expect(screen.getByAltText(
      'Idea2Impact Agent Architecture overview design graph',
    )).toHaveAttribute('src', '/architecture.png')
    expect(screen.queryByRole('button', { name: /editable overview/i }))
      .not.toBeInTheDocument()
  })

  it('sends the exact uploaded PNG directly to the editable PPT skill', async () => {
    const png = new File(
      [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])],
      'architecture.png',
      { type: 'image/png' },
    )
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'running',
        statusUrl: '/editable-pptx/job-1',
        logs: ['Upload accepted'],
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'completed',
        invocationId: 'skill-direct-123',
        sourceImageSha256:
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        downloadUrl: '/editable-pptx/job-1/download',
        logs: ['Upload accepted', 'Validation passed'],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response('PK editable ppt', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const createObjectUrl = vi.fn()
      .mockReturnValueOnce('blob:uploaded-preview')
      .mockReturnValueOnce('blob:editable-pptx')
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: createObjectUrl,
      revokeObjectURL: vi.fn(),
    })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)
    render(
      <EditablePptQuickTest
        endpoint="/editable-pptx"
      />,
    )

    await userEvent.upload(screen.getByLabelText('Choose PNG'), png)
    expect(screen.getByAltText('Exact PNG selected for editable PPT conversion'))
      .toHaveAttribute('src', 'blob:uploaded-preview')
    await userEvent.click(screen.getByRole('button', { name: 'Download as PPT' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/editable-pptx',
      {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: png,
      },
    ))
    expect(click).toHaveBeenCalled()
    expect(await screen.findByText(/Skill skill-direct-123/)).toBeInTheDocument()
    vi.unstubAllGlobals()
  })

  it('downloads the preloaded start-page architecture image without overview generation', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7, 8, 9])
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(png, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'running',
        statusUrl: '/editable-pptx/job-2',
        logs: ['Foundry job started'],
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'completed',
        invocationId: 'skill-start-page',
        sourceImageSha256:
          'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        downloadUrl: '/editable-pptx/job-2/download',
        logs: ['Foundry job started', 'Validation passed'],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response('PK editable ppt', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:editable-pptx'),
      revokeObjectURL: vi.fn(),
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    render(
      <EditablePptQuickTest
        endpoint="/editable-pptx"
        initialImageUrl="/architecture-editable-ppt-test.png"
      />,
    )

    expect(screen.getByAltText('Exact PNG selected for editable PPT conversion'))
      .toHaveAttribute('src', '/architecture-editable-ppt-test.png')
    await userEvent.click(screen.getByRole('button', { name: 'Download as PPT' }))
    await waitFor(() => expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/architecture-editable-ppt-test.png',
    ))
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/editable-pptx',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
      }),
    )
    expect(await screen.findByText(/Skill skill-start-page/)).toBeInTheDocument()
    vi.unstubAllGlobals()
  })

  it('reports an empty proxy failure without attempting to parse JSON', async () => {
    const png = new File(
      [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
      'architecture.png',
      { type: 'image/png' },
    )
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, {
      status: 504,
    })))
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:preview'),
      revokeObjectURL: vi.fn(),
    })
    render(<EditablePptQuickTest endpoint="/editable-pptx" />)

    await userEvent.upload(screen.getByLabelText('Choose PNG'), png)
    await userEvent.click(screen.getByRole('button', { name: 'Download as PPT' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Skill invocation failed (504).',
    )
    expect(screen.queryByText(/Unexpected end of JSON input/)).not.toBeInTheDocument()
    vi.unstubAllGlobals()
  })
})
