import { useEffect, useState } from 'react'
import type {
  ArchitectureGraph,
  ArchitectureVisual,
  ArchitectureVisualMode,
  Slide,
  SlideGenerationProgress,
  SlideGenerationResult,
} from '../types'

interface Props {
  architecture: ArchitectureGraph
  visual: ArchitectureVisual | null
  result: SlideGenerationResult | null
  progress?: SlideGenerationProgress | null
  isGenerating: boolean
  error: string | null
  architectureMode?: ArchitectureVisualMode
  onArchitectureModeChange?: (mode: ArchitectureVisualMode) => void
  onGenerate: () => void
  onCreateVideo?: () => void
}

function ArchitectureSlide({
  architecture,
  visual,
  architectureMode,
}: {
  architecture: ArchitectureGraph
  visual: ArchitectureVisual | null
  architectureMode: ArchitectureVisualMode
}) {
  const activeVisualMode = visual?.mode === 'dual' ? architectureMode : visual?.mode
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
      <div className="slide-architecture-image">
        <iframe
          className="slide-architecture-html-frame"
          src={activeHtmlUrl}
          title={`${architecture.title} overview diagram`}
          sandbox=""
        />
        <span>Copilot HTML + CSS</span>
      </div>
    )
  }
  const activeImageUrl = activeVisualMode === 'narrative-image'
    ? visual?.narrativeImageUrl
    : visual?.imageUrl
  if (
    (activeVisualMode === 'image' || activeVisualMode === 'narrative-image') &&
    activeImageUrl
  ) {
    return (
      <div className="slide-architecture-image">
        <img
          src={activeImageUrl}
          alt={`${architecture.title} overview design graph`}
        />
        <span>Foundry image model</span>
      </div>
    )
  }
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
  visual,
  architectureMode,
  index,
}: {
  slide: Slide
  architecture: ArchitectureGraph
  visual: ArchitectureVisual | null
  architectureMode: ArchitectureVisualMode
  index: number
}) {
  const hasStoryImage = slide.kind !== 'architecture' && Boolean(slide.imageUrl)
  return (
    <article className={`slide-preview theme-azure slide-kind-${slide.kind}${
      hasStoryImage ? ' has-story-image' : ''
    }`}>
      <span className="slide-index">{String(index + 1).padStart(2, '0')}</span>
      <span className="eyebrow">{slide.eyebrow}</span>
      <h3>{slide.title}</h3>
      {slide.subtitle && <p>{slide.subtitle}</p>}
      {slide.kind === 'architecture' ? (
        <ArchitectureSlide
          architecture={architecture}
          visual={visual}
          architectureMode={architectureMode}
        />
      ) : (
        <div className="slide-story-layout">
          {slide.imageUrl && (
            <div className="slide-story-image">
              <img
                src={slide.imageUrl}
                alt={`${slide.title} illustration`}
              />
            </div>
          )}
        </div>
      )}
    </article>
  )
}

export function SlideWorkspace({
  architecture,
  visual,
  result,
  progress,
  isGenerating,
  error,
  architectureMode = 'image',
  onGenerate,
  onCreateVideo,
}: Props) {
  const [activeSlide, setActiveSlide] = useState(0)

  useEffect(() => {
    setActiveSlide(0)
  }, [result])

  return (
    <section className="slide-workspace" aria-labelledby="slide-workspace-title">
      <header className="slide-workspace-heading">
        <div>
          <span className="eyebrow">Step 03 / Generate slides</span>
          <h2 id="slide-workspace-title">Turn the approved outline into a deck</h2>
          <p>
            The deck turns Problem, User Scenarios, and Solution into full-slide
            images that can be downloaded directly as HTML or PowerPoint.
          </p>
        </div>
        {result && <span className="asset-badge">Stored with lineage</span>}
      </header>

      {isGenerating && progress && (
        <div className="slide-generation-progress" aria-live="polite">
          <div>
            <strong>{progress.stage}</strong>
            <span>{progress.percent}%</span>
          </div>
          <progress
            max="100"
            value={progress.percent}
            aria-label="Slide generation progress"
          />
          <p>{progress.log}</p>
        </div>
      )}

      {!result ? (
        <div className="slide-generation-empty">
          <div className="deck-skeleton" aria-hidden="true">
            <span>Problem</span>
            <span>User scenarios</span>
            <span>Solution</span>
            <span>Overview</span>
          </div>
          <div>
            <strong>Ready to compose {architecture.title}</strong>
            <p>
              Copilot will choose the right number of slides while covering Problem
              Statement, User Scenarios, and Solution with a dedicated visual per slide.
            </p>
            {error && <p className="slide-error" role="alert">{error}</p>}
            <button
              type="button"
              className="generate-slides-button"
              disabled={isGenerating}
              onClick={onGenerate}
            >
              {isGenerating ? 'Generating slides...' : 'Generate slides'}
            </button>
          </div>
        </div>
      ) : (
        <div className="deck-review">
          <div className="slide-stage">
            <SlideContent
              slide={result.deck.slides[activeSlide]}
              architecture={architecture}
              visual={visual}
              architectureMode={architectureMode}
              index={activeSlide}
            />
          </div>
          <div className="slide-review-panel">
            <div className="deck-actions">
              <div>
                <span className="eyebrow">Image deck ready</span>
                <strong>{result.deck.slides.length} slides</strong>
              </div>
              <div>
                <a href={result.previewUrl} target="_blank" rel="noreferrer">
                  Open deck
                </a>
                <a href={result.downloadUrl} download>
                  Download HTML
                </a>
                <a href={result.pptxDownloadUrl} download>
                  Download PPTX
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
            {onCreateVideo && (
              <button
                type="button"
                className="create-slide-video-button"
                disabled={isGenerating}
                onClick={onCreateVideo}
              >
                Generate video
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
