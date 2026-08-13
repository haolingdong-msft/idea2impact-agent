import { useEffect, useMemo, useState } from 'react'
import { useVideoRefinement } from '../hooks/useVideoRefinement'
import type { VideoRefinementOptions } from '../types'

const DEFAULT_OPTIONS: VideoRefinementOptions = {
  targetSpeed: 4,
  minimumInactiveDuration: 2.5,
  clarity: 'standard',
  resolution: 'source',
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.max(0, seconds - minutes * 60)
  return `${minutes}:${remainder.toFixed(1).padStart(4, '0')}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

interface Props {
  projectId?: string
  standalone?: boolean
  onUploadComplete?: () => void
  onRefinementComplete?: () => void
}

export function VideoWorkspace({
  projectId,
  standalone = false,
  onUploadComplete,
  onRefinementComplete,
}: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [options, setOptions] = useState(DEFAULT_OPTIONS)
  const {
    result,
    upload,
    isUploading,
    isProcessing,
    error,
    uploadVideo,
    refineUploadedVideo,
    refineVideo,
    clearUpload,
  } = useVideoRefinement()
  const sourcePreview = useMemo(() => file ? URL.createObjectURL(file) : null, [file])

  useEffect(() => () => {
    if (sourcePreview) URL.revokeObjectURL(sourcePreview)
  }, [sourcePreview])

  const submit = async () => {
    if (!file) return
    if (standalone || !projectId) {
      await refineVideo(file, options, projectId)
      onRefinementComplete?.()
      return
    }
    await uploadVideo(file, projectId)
    onUploadComplete?.()
  }

  const refine = async () => {
    if (!projectId || !upload) return
    await refineUploadedVideo(projectId, upload.asset.id, options)
    onRefinementComplete?.()
  }

  return (
    <section className="video-workspace" aria-labelledby="video-workspace-title">
      <header className="video-heading">
        <div>
          <span className="eyebrow">
            {standalone ? 'Start directly / Video polish' : 'Steps 07-08 / Recording'}
          </span>
          <h2 id="video-workspace-title">
            {standalone ? 'Refine an existing video' : 'Upload, then refine the recording'}
          </h2>
          <p>
            {standalone
              ? 'Skip slide creation and upload a recording now. The agent detects low-motion idle ranges, improves perceived clarity, and renders a shorter MP4.'
              : 'First preserve the source recording as a project asset. Then inspect it, accelerate conservative inactive ranges, improve perceived clarity, and render a new MP4.'}
          </p>
        </div>
        <span className="source-safe-badge">Source stays unchanged</span>
      </header>

      <div className="video-grid">
        <div className="video-controls">
          <label className={`video-dropzone ${file ? 'has-file' : ''}`}>
            <input
              type="file"
              accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.m4v"
              onChange={event => {
                setFile(event.target.files?.[0] || null)
                clearUpload()
              }}
            />
            <span className="upload-mark">{file ? 'OK' : 'UP'}</span>
            <div>
              <strong>{file ? file.name : 'Choose a demo recording'}</strong>
              <small>
                {file
                  ? `${formatBytes(file.size)} / original retained in this session`
                  : 'MP4, MOV, MKV, WebM, or M4V'}
              </small>
            </div>
          </label>

          <div className="video-option-grid">
            <label>
              <span>Inactive-part speed</span>
              <select
                value={options.targetSpeed}
                onChange={event => setOptions(current => ({
                  ...current,
                  targetSpeed: Number(event.target.value),
                }))}
              >
                <option value={2}>2x conservative</option>
                <option value={4}>4x balanced</option>
                <option value={6}>6x fast</option>
              </select>
            </label>
            <label>
              <span>Minimum inactive range</span>
              <select
                value={options.minimumInactiveDuration}
                onChange={event => setOptions(current => ({
                  ...current,
                  minimumInactiveDuration: Number(event.target.value),
                }))}
              >
                <option value={2}>2 seconds</option>
                <option value={2.5}>2.5 seconds</option>
                <option value={4}>4 seconds</option>
              </select>
            </label>
            <label>
              <span>Picture clarity</span>
              <select
                value={options.clarity}
                onChange={event => setOptions(current => ({
                  ...current,
                  clarity: event.target.value as VideoRefinementOptions['clarity'],
                }))}
              >
                <option value="standard">Standard / text-safe</option>
                <option value="strong">Strong</option>
                <option value="none">No enhancement</option>
              </select>
            </label>
            <label>
              <span>Output resolution</span>
              <select
                value={options.resolution}
                onChange={event => setOptions(current => ({
                  ...current,
                  resolution: event.target.value as VideoRefinementOptions['resolution'],
                }))}
              >
                <option value="source">Preserve source</option>
                <option value="1080p">Fit to 1080p</option>
                <option value="4k">Fit to 4K</option>
              </select>
            </label>
          </div>

          <div className="video-disclosure">
            <strong>Detection rule</strong>
            <p>
              Motion below roughly 1% of the frame is treated as idle, so cursors
              and loading spinners do not keep a hanging section at full speed.
              Audio follows the same timing to preserve synchronization.
            </p>
          </div>

          {error && <p className="video-error" role="alert">{error}</p>}
          <button
            type="button"
            className="refine-button"
            disabled={!file || isProcessing || isUploading || (!standalone && Boolean(upload))}
            onClick={() => void submit()}
          >
            {standalone
              ? isProcessing
                ? 'Inspecting and rendering a new video...'
                : 'Create refined video'
              : isUploading
                ? 'Uploading source recording...'
                : upload
                  ? 'Source recording uploaded'
                  : 'Upload source recording'}
          </button>
          {!standalone && upload && (
            <button
              type="button"
              className="refine-button refine-stored-button"
              disabled={isProcessing}
              onClick={() => void refine()}
            >
              {isProcessing ? 'Inspecting and rendering...' : 'Refine uploaded recording'}
            </button>
          )}
        </div>

        <div className="video-preview">
          {sourcePreview ? (
            <>
              <span className="preview-label">
                {result ? 'Refined output preview' : 'Source preview'}
              </span>
              <video
                controls
                preload="metadata"
                src={result?.output.downloadUrl || sourcePreview}
              />
            </>
          ) : (
            <div className="video-empty">
              <span>VIDEO</span>
              <strong>Your source preview appears here</strong>
              <p>The uploaded file is never overwritten.</p>
            </div>
          )}
        </div>
      </div>

      {result && (
        <div className="video-result">
          <div className="result-heading">
            <div>
              <span className="eyebrow">New output ready</span>
              <h3>Refinement summary</h3>
            </div>
            <a href={result.output.downloadUrl} download>
              Download refined MP4
            </a>
          </div>
          <div className="result-metrics">
            <div>
              <span>Duration</span>
              <strong>
                {formatDuration(result.processing.originalDuration)} →{' '}
                {formatDuration(result.processing.outputDuration)}
              </strong>
            </div>
            <div>
              <span>Picture</span>
              <strong>
                {result.source.video.width}x{result.source.video.height} →{' '}
                {result.output.metadata.video.width}x{result.output.metadata.video.height}
              </strong>
            </div>
            <div>
              <span>Inactive edits</span>
              <strong>{result.processing.acceleratedRanges.length}</strong>
            </div>
            <div>
              <span>Output size</span>
              <strong>{formatBytes(result.output.metadata.sizeBytes)}</strong>
            </div>
          </div>
          <div className="result-details">
            <div>
              <strong>Applied</strong>
              <p>{result.processing.filters.join(' / ')}</p>
            </div>
            <div>
              <strong>Accelerated ranges</strong>
              <p>
                {result.processing.acceleratedRanges.length
                  ? result.processing.acceleratedRanges
                      .map(range =>
                        `${formatDuration(range.start)}-${formatDuration(range.end)} at ${range.speed.toFixed(1)}x`)
                      .join(' / ')
                  : 'None; the source pacing was preserved.'}
              </p>
            </div>
            {result.processing.warnings.length > 0 && (
              <div className="result-warning">
                <strong>Quality notes</strong>
                <p>{result.processing.warnings.join(' / ')}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
