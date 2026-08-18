import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type SlideVideoPlan = {
  jobId: string
  title: string
  targetDurationSeconds: number
  slides: Array<{
    slideId: string
    slideTitle: string
    script: string
    durationSeconds: number
  }>
}

type SlideVideoResult = {
  jobId: string
  durationSeconds: number
  slideCount: number
  audio: 'azure-neural-voice'
  voice: string
  subtitles: 'embedded'
  downloadUrl: string
  subtitleDownloadUrl: string
}

async function responsePayload<T>(response: Response): Promise<T & { error?: string }> {
  const text = await response.text()
  if (!text) return {} as T
  try {
    return JSON.parse(text) as T & { error?: string }
  } catch {
    throw new Error(`Slide video service returned an invalid response (${response.status}).`)
  }
}

type Props = {
  sourceUrl?: string
  sourceName?: string
  autoStart?: boolean
  onComplete?: () => void
}

export function SlideVideoWorkspace({
  sourceUrl,
  sourceName = 'Generated presentation slides',
  autoStart = false,
  onComplete,
}: Props = {}) {
  const [file, setFile] = useState<File | null>(null)
  const [durationSeconds, setDurationSeconds] = useState(90)
  const [voice, setVoice] = useState('en-US-AvaMultilingualNeural')
  const [plan, setPlan] = useState<SlideVideoPlan | null>(null)
  const [result, setResult] = useState<SlideVideoResult | null>(null)
  const [stage, setStage] = useState<'idle' | 'planning' | 'ready' | 'rendering' | 'complete'>('idle')
  const [error, setError] = useState<string | null>(null)
  const autoStartedSourceRef = useRef<string | null>(null)
  const previewUrl = useMemo(
    () => result ? result.downloadUrl : null,
    [result],
  )

  const createPlan = useCallback(async () => {
    if (!file && !sourceUrl) return
    setStage('planning')
    setError(null)
    try {
      let body: BodyInit
      let contentType: string
      let fileName: string
      if (file) {
        body = file
        contentType = file.type === 'text/html'
          ? 'text/html'
          : 'application/octet-stream'
        fileName = file.name
      } else {
        const sourceResponse = await fetch(sourceUrl!)
        if (!sourceResponse.ok) {
          throw new Error(
            `Generated slide deck download failed (${sourceResponse.status}).`,
          )
        }
        body = await sourceResponse.blob()
        contentType = 'text/html'
        fileName = 'presentation-slides.html'
      }
      const response = await fetch(
        `/slide-video/plan?targetDurationSeconds=${durationSeconds}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': contentType,
            'X-File-Name': encodeURIComponent(fileName),
          },
          body,
        },
      )
      const payload = await responsePayload<SlideVideoPlan>(response)
      if (!response.ok || !payload.jobId) {
        throw new Error(payload.error || `Slide analysis failed (${response.status}).`)
      }
      setPlan(payload)
      setDurationSeconds(payload.targetDurationSeconds)
      setStage('ready')
    } catch (caught) {
      setStage('idle')
      setError(caught instanceof Error ? caught.message : 'Slide analysis failed.')
    }
  }, [durationSeconds, file, sourceUrl])

  useEffect(() => {
    setPlan(null)
    setResult(null)
    setStage('idle')
    setError(null)
  }, [file, sourceUrl])

  useEffect(() => {
    if (!file && sourceUrl && autoStart) {
      if (autoStartedSourceRef.current === sourceUrl) return
      autoStartedSourceRef.current = sourceUrl
      void createPlan()
    }
  }, [file, sourceUrl, autoStart, createPlan])

  const renderVideo = async () => {
    if (!plan) return
    setStage('rendering')
    setError(null)
    try {
      const response = await fetch(`/slide-video/${plan.jobId}/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetDurationSeconds: durationSeconds,
          voice,
          slides: plan.slides.map(slide => ({ script: slide.script })),
        }),
      })
      const payload = await responsePayload<SlideVideoResult>(response)
      if (!response.ok || !payload.downloadUrl) {
        throw new Error(payload.error || `Video rendering failed (${response.status}).`)
      }
      setResult(payload)
      setStage('complete')
      onComplete?.()
    } catch (caught) {
      setStage('ready')
      setError(caught instanceof Error ? caught.message : 'Video rendering failed.')
    }
  }

  return (
    <section className="slide-video-workspace" aria-labelledby="slide-video-title">
      <header className="slide-video-heading">
        <div>
          <span className="eyebrow">Step 04 / Generate video</span>
          <h2 id="slide-video-title">Turn an HTML slide deck into a timed video</h2>
          <p>
            Upload generated HTML slides, choose the exact total duration, review
            one AI-written script per slide, then render a 1080p MP4.
          </p>
        </div>
        <span className="source-safe-badge">HTML stays unchanged</span>
      </header>

      <div className="slide-video-controls">
        <label className={`video-dropzone ${file ? 'has-file' : ''}`}>
          <input
            type="file"
            accept="text/html,.html,.htm"
            onChange={event => setFile(event.target.files?.[0] || null)}
          />
          <span className="upload-mark">{file ? 'OK' : 'UP'}</span>
          <div>
            <strong>{file?.name || (sourceUrl ? sourceName : 'Choose an HTML slide deck')}</strong>
            <small>
              {file
                ? `${(file.size / 1024 / 1024).toFixed(1)} MB`
                : sourceUrl
                  ? 'Using the generated HTML deck from this project'
                : 'Generated deck HTML with one .slide element per page'}
            </small>
          </div>
        </label>

        <label className="slide-video-duration">
          <span>Narration voice</span>
          <select value={voice} onChange={event => setVoice(event.target.value)}>
            <option value="en-US-AvaMultilingualNeural">Ava multilingual</option>
            <option value="en-US-AndrewMultilingualNeural">Andrew multilingual</option>
            <option value="zh-CN-XiaoxiaoNeural">晓晓（中文女声）</option>
            <option value="zh-CN-YunxiNeural">云希（中文男声）</option>
          </select>
        </label>

        <label className="slide-video-duration">
          <span>Total video duration</span>
          <div>
            <input
              type="number"
              min="15"
              max="1800"
              step="5"
              value={durationSeconds}
              onChange={event => setDurationSeconds(Number(event.target.value))}
            />
            <strong>seconds</strong>
          </div>
        </label>

        <button
          type="button"
          className="refine-button"
          disabled={(!file && !sourceUrl) || stage === 'planning' || stage === 'rendering'}
          onClick={() => void createPlan()}
        >
          {stage === 'planning' ? 'Reading slides and writing scripts...' : 'Generate video plan'}
        </button>
      </div>

      {stage === 'planning' && (
        <p className="slide-video-progress" role="status">
          Extracting slide text and writing narration for the requested duration...
        </p>
      )}
      {error && <p className="video-error" role="alert">{error}</p>}

      {plan && (
        <div className="slide-video-plan">
          <header>
            <div>
              <span className="eyebrow">{plan.slides.length} slides detected</span>
              <h3>{plan.title}</h3>
            </div>
            <strong>{durationSeconds}s total</strong>
          </header>
          <div className="slide-script-list">
            {plan.slides.map((slide, index) => (
              <label key={slide.slideId}>
                <span>
                  {String(index + 1).padStart(2, '0')} / {slide.slideTitle}
                  <small>~{slide.durationSeconds.toFixed(1)}s</small>
                </span>
                <textarea
                  value={slide.script}
                  rows={5}
                  onChange={event => setPlan(current => current && ({
                    ...current,
                    slides: current.slides.map(item =>
                      item.slideId === slide.slideId
                        ? { ...item, script: event.target.value }
                        : item),
                  }))}
                />
              </label>
            ))}
          </div>
          <button
            type="button"
            className="refine-button"
            disabled={stage === 'rendering'}
            onClick={() => void renderVideo()}
          >
            {stage === 'rendering'
              ? 'Capturing slides and rendering MP4...'
              : 'Generate video'}
          </button>
          {stage === 'rendering' && (
            <p className="slide-video-progress" role="status">
              Capturing every slide at 1080p, timing scenes, and embedding the
              script as a subtitle track...
            </p>
          )}
        </div>
      )}

      {result && previewUrl && (
        <div className="slide-video-result">
          <div className="result-heading">
            <div>
              <span className="eyebrow">Video ready</span>
              <h3>{result.slideCount} slides / {result.durationSeconds}s</h3>
            </div>
            <div className="slide-video-downloads">
              <a href={result.downloadUrl} download>Download MP4</a>
              <a href={result.subtitleDownloadUrl} download>Download script (SRT)</a>
            </div>
          </div>
          <video controls preload="metadata" src={previewUrl} />
          <p>
            Azure AI Speech narration uses {result.voice}; the approved scripts
            are also retained as an embedded subtitle track.
          </p>
        </div>
      )}
    </section>
  )
}
