import { useEffect, useState } from 'react'
import type {
  ArchitectureGraph,
  Slide,
  SlideGenerationResult,
} from '../types'

interface Props {
  architecture: ArchitectureGraph
  result: SlideGenerationResult | null
  isGenerating: boolean
  error: string | null
  onGenerate: () => void
}

function ArchitectureSlide({
  architecture,
}: {
  architecture: ArchitectureGraph
}) {
  const nodeNames = new Map(
    architecture.layers.flatMap(layer => layer.nodes.map(node => [node.id, node.label])),
  )
  return (
    <div className="slide-architecture-composition">
      <div className="slide-architecture-visual">
        {architecture.layers.map(layer => (
          <article key={layer.id}>
            <strong>{layer.label}</strong>
            <small>{layer.purpose}</small>
            <div>
              {layer.nodes.map(node => (
                <span className={node.provenance === 'assumed' ? 'assumed' : ''} key={node.id}>
                  <b>{node.label}</b>
                  <em>{node.technology || 'Technology unspecified'}</em>
                </span>
              ))}
            </div>
          </article>
        ))}
      </div>
      <div className="slide-architecture-flows">
        {architecture.connections
          .filter(connection => connection.primary)
          .slice(0, 4)
          .map((connection, index) => (
            <span key={`${connection.from}-${connection.to}-${index}`}>
              <b>{nodeNames.get(connection.from)} → {nodeNames.get(connection.to)}</b>
              <em>{connection.label || 'connects to'}</em>
              <small>
                {connection.mechanism || 'mechanism unspecified'} /{' '}
                {connection.payload || 'payload unspecified'}
              </small>
            </span>
          ))}
      </div>
    </div>
  )
}

function SlideContent({
  slide,
  architecture,
  index,
}: {
  slide: Slide
  architecture: ArchitectureGraph
  index: number
}) {
  return (
    <article className={`slide-preview theme-azure slide-kind-${slide.kind}`}>
      <span className="slide-index">{String(index + 1).padStart(2, '0')}</span>
      <span className="eyebrow">{slide.eyebrow}</span>
      <h3>{slide.title}</h3>
      {slide.subtitle && <p>{slide.subtitle}</p>}
      {slide.kind === 'architecture' ? (
        <ArchitectureSlide architecture={architecture} />
      ) : (
        <ul>
          {slide.bullets.map((bullet, bulletIndex) => (
            <li key={`${slide.id}-${bulletIndex}`}>{bullet}</li>
          ))}
        </ul>
      )}
    </article>
  )
}

export function SlideWorkspace({
  architecture,
  result,
  isGenerating,
  error,
  onGenerate,
}: Props) {
  const [activeSlide, setActiveSlide] = useState(0)

  useEffect(() => {
    setActiveSlide(0)
  }, [result])

  return (
    <section className="slide-workspace" aria-labelledby="slide-workspace-title">
      <header className="slide-workspace-heading">
        <div>
          <span className="eyebrow">Step 04 / Generate slides</span>
          <h2 id="slide-workspace-title">Turn the approved story into a deck</h2>
          <p>
            The deck reuses the stored brief, approvals, and architecture. HTML is
            generated as a versioned project asset and can be opened or downloaded.
          </p>
        </div>
        {result && <span className="asset-badge">Stored with lineage</span>}
      </header>

      {!result ? (
        <div className="slide-generation-empty">
          <div className="deck-skeleton" aria-hidden="true">
            <span>Problem</span>
            <span>User story</span>
            <span>Architecture</span>
          </div>
          <div>
            <strong>Ready to compose {architecture.title}</strong>
            <p>
              Copilot will produce a title, problem, user-story, and architecture
              slide without changing the approved technical design.
            </p>
            {error && <p className="slide-error" role="alert">{error}</p>}
            <button
              type="button"
              className="generate-slides-button"
              disabled={isGenerating}
              onClick={onGenerate}
            >
              {isGenerating ? 'Composing HTML slides...' : 'Generate HTML slides'}
            </button>
          </div>
        </div>
      ) : (
        <div className="deck-review">
          <div className="slide-stage">
            <SlideContent
              slide={result.deck.slides[activeSlide]}
              architecture={architecture}
              index={activeSlide}
            />
          </div>
          <div className="slide-review-panel">
            <div className="deck-actions">
              <div>
                <span className="eyebrow">HTML deck ready</span>
                <strong>{result.deck.slides.length} slides</strong>
              </div>
              <div>
                <a href={result.previewUrl} target="_blank" rel="noreferrer">
                  Open deck
                </a>
                <a href={result.downloadUrl} download>
                  Download HTML
                </a>
              </div>
            </div>
            <div className="slide-thumbnails">
              {result.deck.slides.map((slide, index) => (
                <button
                  type="button"
                  className={index === activeSlide ? 'active' : ''}
                  onClick={() => setActiveSlide(index)}
                  key={slide.id}
                  aria-label={`Show slide ${index + 1}: ${slide.title}`}
                >
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <div>
                    <strong>{slide.title}</strong>
                    <small>{slide.kind.replace('-', ' ')}</small>
                  </div>
                </button>
              ))}
            </div>
            <button
              type="button"
              className="regenerate-slides-button"
              disabled={isGenerating}
              onClick={onGenerate}
            >
              {isGenerating ? 'Regenerating...' : 'Regenerate deck'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
