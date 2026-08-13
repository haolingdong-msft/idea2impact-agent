import { useLayoutEffect, useRef, useState } from 'react'
import type {
  ArchitectureGraph,
  ArchitectureNodeKind,
  ArchitectureVisual,
  ArchitectureVisualMode,
} from '../types'
import { ArchitectureModeSwitcher } from './ArchitectureModeSwitcher'

interface Props {
  architecture: ArchitectureGraph | null
  visual: ArchitectureVisual | null
  isLoading: boolean
  error: string | null
  selectedMode?: ArchitectureVisualMode
  onSelectedModeChange?: (mode: ArchitectureVisualMode) => void
}

const KIND_LABELS: Record<ArchitectureNodeKind, string> = {
  actor: 'Actor',
  interface: 'Interface',
  agent: 'Agent',
  service: 'Service',
  data: 'Data',
  integration: 'Integration',
  security: 'Security',
}

type Connector = ArchitectureGraph['connections'][number] & {
  path: string
  labelX: number
  labelY: number
}

export function ArchitectureCanvas({
  architecture,
  visual,
  isLoading,
  error,
  selectedMode = 'image',
  onSelectedModeChange,
}: Props) {
  const diagramRef = useRef<HTMLDivElement>(null)
  const [connectors, setConnectors] = useState<Connector[]>([])

  useLayoutEffect(() => {
    const diagram = diagramRef.current
    if (!diagram || !architecture) {
      setConnectors([])
      return
    }

    const measure = () => {
      const diagramRect = diagram.getBoundingClientRect()
      const nodes = new Map(
        [...diagram.querySelectorAll<HTMLElement>('[data-node-id]')]
          .map(node => [node.dataset.nodeId || '', node.getBoundingClientRect()]),
      )
      setConnectors(architecture.connections.flatMap(connection => {
        const from = nodes.get(connection.from)
        const to = nodes.get(connection.to)
        if (!from || !to) return []
        const forward = to.left >= from.left
        const startX = (forward ? from.right : from.left) - diagramRect.left
        const endX = (forward ? to.left : to.right) - diagramRect.left
        const startY = from.top + from.height / 2 - diagramRect.top
        const endY = to.top + to.height / 2 - diagramRect.top
        const direction = forward ? 1 : -1
        const bend = Math.max(36, Math.abs(endX - startX) * 0.42)
        return [{
          ...connection,
          path: [
            `M ${startX.toFixed(1)} ${startY.toFixed(1)}`,
            `C ${(startX + direction * bend).toFixed(1)} ${startY.toFixed(1)}`,
            `${(endX - direction * bend).toFixed(1)} ${endY.toFixed(1)}`,
            `${endX.toFixed(1)} ${endY.toFixed(1)}`,
          ].join(' '),
          labelX: (startX + endX) / 2,
          labelY: (startY + endY) / 2 - 7,
        }]
      }))
    }

    measure()
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(measure)
    observer?.observe(diagram)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [architecture])

  if (isLoading) {
    return (
      <section className="architecture-empty architecture-loading">
        <div className="loader-orbit"><span /></div>
        <h2>Composing the system</h2>
        <p>Finding the clearest layers, components, and primary flow.</p>
      </section>
    )
  }

  if (error) {
    return (
      <section className="architecture-empty architecture-error">
        <span className="empty-code">ERR</span>
        <h2>Architecture could not be generated</h2>
        <p>{error}</p>
      </section>
    )
  }

  if (!architecture) {
    return (
      <section className="architecture-empty">
        <div className="empty-grid" aria-hidden="true">
          <span /><span /><span /><span /><span /><span />
        </div>
        <h2>Your architecture canvas is ready</h2>
        <p>Complete the brief to turn your idea into a presentation-ready system graph.</p>
      </section>
    )
  }

  const activeVisualMode = visual?.mode === 'dual' ? selectedMode : visual?.mode
  const visualSwitcher = visual?.mode === 'dual' ? (
    <ArchitectureModeSwitcher
      selectedMode={selectedMode}
      onSelectedModeChange={onSelectedModeChange}
    />
  ) : null

  const activeHtmlUrl = activeVisualMode === 'narrative-html'
    ? visual?.narrativeHtmlUrl
    : activeVisualMode === 'image-html'
      ? visual?.imageDerivedHtmlUrl
    : activeVisualMode === 'validated-json-html'
      ? visual?.validatedJsonHtmlUrl
      : visual?.htmlUrl
  if (
    (
      activeVisualMode === 'html' ||
      activeVisualMode === 'narrative-html' ||
      activeVisualMode === 'image-html' ||
      activeVisualMode === 'validated-json-html'
    ) &&
    activeHtmlUrl
  ) {
    return (
      <section className="architecture-canvas architecture-image-canvas">
        <header className="canvas-header">
          <div>
            <span className="eyebrow">
              {activeVisualMode === 'narrative-html'
                ? 'Agent narrative → Copilot HTML + CSS'
                : activeVisualMode === 'image-html'
                  ? 'GPT-Image-2 → vision extraction → Copilot HTML + CSS'
                : activeVisualMode === 'validated-json-html'
                  ? 'Validated JSON → Copilot HTML + CSS'
                : 'Full-context Copilot HTML + CSS'}
            </span>
            <h2>{architecture.title}</h2>
            <p>{architecture.summary}</p>
          </div>
          <span className="image-model-badge">Creative / non-deterministic</span>
        </header>
        {visualSwitcher}
        <iframe
          className="architecture-html-frame"
          src={activeHtmlUrl}
          title={`${architecture.title} architecture diagram`}
          sandbox=""
        />
      </section>
    )
  }

  const activeImageUrl = activeVisualMode === 'narrative-image'
    ? visual?.narrativeImageUrl
    : visual?.imageUrl
  if (
    (activeVisualMode === 'image' || activeVisualMode === 'narrative-image') &&
    activeImageUrl
  ) {
    const editablePptxUrl = visual?.pptxDownloadUrl ||
      activeImageUrl.replace(/\/architecture\/image$/, '/architecture/download.pptx')
    return (
      <section className="architecture-canvas architecture-image-canvas">
        <header className="canvas-header">
          <div>
            <span className="eyebrow">
              {activeVisualMode === 'narrative-image'
                ? 'Agent narrative → Foundry image generation'
                : 'Validated JSON → Foundry image generation'}
            </span>
            <h2>{architecture.title}</h2>
            <p>{architecture.summary}</p>
          </div>
          <span className="image-model-badge">Designed image graph</span>
        </header>
        {visualSwitcher}
        <img
          src={activeImageUrl}
          alt={`${architecture.title} architecture design graph`}
        />
        {editablePptxUrl && (
          <a
            className="architecture-pptx-download"
            href={editablePptxUrl}
            download
          >
            Download editable PPTX
          </a>
        )}
      </section>
    )
  }

  const nodeNames = new Map(
    architecture.layers.flatMap(layer => layer.nodes.map(node => [node.id, node.label])),
  )
  const nodePlatforms = new Map(
    architecture.platforms.flatMap(platform =>
      platform.componentNodeIds.map(nodeId => [nodeId, platform.label] as const)),
  )
  const platformNames = new Map(
    architecture.platforms.map(platform => [platform.id, platform.label]),
  )
  const toolingNames = new Map(
    architecture.platforms.flatMap(platform =>
      (platform.toolings || []).map(tooling => [tooling.id, tooling.label] as const)),
  )

  return (
    <section className="architecture-canvas">
      <header className="canvas-header">
        <div>
          <span className="eyebrow">HTML architecture</span>
          <h2>{architecture.title}</h2>
          <p>{architecture.summary}</p>
        </div>
        <span className="live-badge"><i /> Generated</span>
      </header>

      <div className="interaction-legend" aria-label="Architecture interaction legend">
        {(['request', 'event', 'data', 'auth'] as const).map(type => (
          <span className={`legend-${type}`} key={type}><i />{type}</span>
        ))}
        <span className="legend-assumed"><i />assumed</span>
      </div>

      <div className="architecture-diagram" ref={diagramRef}>
        <svg
          className="architecture-connectors"
          aria-hidden="true"
          width="100%"
          height="100%"
        >
          <defs>
            {(['request', 'event', 'data', 'auth'] as const).map(type => (
              <marker
                id={`arrow-${type}`}
                key={type}
                markerWidth="7"
                markerHeight="7"
                refX="6"
                refY="3.5"
                orient="auto"
              >
                <path d="M0,0 L7,3.5 L0,7 Z" fill="context-stroke" />
              </marker>
            ))}
          </defs>
          {connectors.map((connection, index) => {
            const type = connection.type || 'request'
            return (
              <g
                className={[
                  'connector',
                  `connector-${type}`,
                  connection.primary ? 'primary' : '',
                  connection.provenance === 'assumed' ? 'assumed' : '',
                ].filter(Boolean).join(' ')}
                key={`${connection.from}-${connection.to}-${index}`}
              >
                <path
                  d={connection.path}
                  markerEnd={`url(#arrow-${type})`}
                />
                {connection.primary && (
                  <text x={connection.labelX} y={connection.labelY}>
                    {connection.mechanism || connection.label}
                  </text>
                )}
              </g>
            )
          })}
        </svg>

        <div
          className="architecture-layers"
          style={{ gridTemplateColumns: `repeat(${architecture.layers.length}, minmax(160px, 1fr))` }}
        >
          {architecture.layers.map((layer, layerIndex) => (
            <article className={`architecture-layer tone-${layer.tone}`} key={layer.id}>
              <header>
                <span>{String(layerIndex + 1).padStart(2, '0')}</span>
                <div>
                  <h3>{layer.label}</h3>
                  <p>{layer.purpose}</p>
                </div>
              </header>
              <div className="node-stack">
                {layer.nodes.map(node => (
                  <div
                    className={[
                      'architecture-node',
                      `kind-${node.kind}`,
                      node.provenance === 'assumed' ? 'assumed' : '',
                    ].filter(Boolean).join(' ')}
                    data-node-id={node.id}
                    key={node.id}
                  >
                    <div className="node-mark">{node.label.slice(0, 2).toUpperCase()}</div>
                    <div>
                      <div className="node-meta">
                        <span>{KIND_LABELS[node.kind]}</span>
                        <span className="technology-badge">
                          {node.technology || 'Technology unspecified'}
                        </span>
                        {node.provenance === 'assumed' && (
                          <span className="assumption-badge">Assumed</span>
                        )}
                      </div>
                      <h4>{node.label}</h4>
                      <p>{node.description}</p>
                      {node.evidencePaths?.length > 0 && (
                        <small className="evidence-paths">
                          {node.evidencePaths.slice(0, 3).join(' / ')}
                        </small>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </article>
          ))}
        </div>
      </div>

      <div className="workflow-map">
        <div className="flow-map-heading">
          <span className="eyebrow">User workflow · {architecture.workflow.actor}</span>
          <strong>{architecture.workflow.goal}</strong>
        </div>
        <div className="workflow-platforms">
          {architecture.platforms.map(platform => (
            <div key={platform.id}>
              <strong>{platform.label}</strong>
              <small>{platform.technology}</small>
              <span>
                Components: {platform.componentNodeIds
                  .map(nodeId => nodeNames.get(nodeId) || nodeId)
                  .join(' · ')}
              </span>
              <span>
                Toolings: {(platform.toolings || [])
                  .map(tooling => tooling.label)
                  .join(' · ') || 'Derived from components'}
              </span>
            </div>
          ))}
        </div>
        <div className="workflow-steps">
          {architecture.workflow.steps.map(step => (
            <article className="workflow-step" key={step.id}>
              <span>{step.order}</span>
              <div>
                <h4>{step.label}</h4>
                <p>{step.userAction}</p>
                <div className="workflow-platform-calls">
                  {step.platformCalls.map((call, callIndex) => (
                    <small key={`${step.id}-${call.nodeId}-${callIndex}`}>
                      <b>
                        {platformNames.get(call.platformId) || call.platformId} →{' '}
                        {toolingNames.get(call.toolingId) || call.toolingId}
                      </b>
                      <em>
                        {nodeNames.get(call.nodeId) || call.nodeId} · {call.action}
                      </em>
                      <span>{call.mechanism} → {call.output}</span>
                    </small>
                  ))}
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>

      {architecture.connections.length > 0 && (
        <div className="flow-map">
          <div className="flow-map-heading">
            <span className="eyebrow">Technical component interactions</span>
            <strong>{architecture.connections.length} flows</strong>
          </div>
          <div className="flow-list">
            {architecture.connections.map((connection, index) => (
              <div
                className={[
                  'flow-item',
                  `flow-${connection.type || 'request'}`,
                  connection.primary ? 'primary' : '',
                  connection.provenance === 'assumed' ? 'assumed' : '',
                ].filter(Boolean).join(' ')}
                key={`${connection.from}-${connection.to}-${index}`}
              >
                <span>{nodeNames.get(connection.from) || connection.from}</span>
                <div>
                  <i />
                  <em>
                    <strong>{connection.label || 'connects to'}</strong>
                    <small>
                      {connection.mechanism || 'mechanism unspecified'} /{' '}
                      {connection.payload || 'payload unspecified'}
                    </small>
                    {connection.evidencePaths?.length > 0 && (
                      <small className="evidence-paths">
                        {connection.evidencePaths.slice(0, 3).join(' / ')}
                      </small>
                    )}
                  </em>
                  <i />
                </div>
                <span>{nodeNames.get(connection.to) || connection.to}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {architecture.assumptions.length > 0 && (
        <aside className="assumption-bar">
          <strong>Assumptions</strong>
          <p>{architecture.assumptions.join(' / ')}</p>
        </aside>
      )}
    </section>
  )
}
