export interface Message {
  id: string
  role: 'user' | 'assistant' | 'error'
  content: string
}

export interface PresentationBrief {
  title: string
  idea: string
  audience: string
  purpose: string
  repositoryUrl?: string
}

export interface PresentationOutline {
  problemStatement: string
  userScenarios: string
  solution: string
  status: 'draft' | 'approved'
  approvedAt?: string
}

export type ArchitectureNodeKind =
  | 'actor'
  | 'interface'
  | 'agent'
  | 'service'
  | 'data'
  | 'integration'
  | 'security'

export interface ArchitectureNode {
  id: string
  label: string
  description: string
  kind: ArchitectureNodeKind
  technology: string
  provenance: 'confirmed' | 'assumed'
  evidencePaths?: string[]
}

export interface ArchitectureLayer {
  id: string
  label: string
  purpose: string
  tone: 'navy' | 'blue' | 'teal' | 'violet' | 'amber'
  nodes: ArchitectureNode[]
}

export interface ArchitectureGraph {
  title: string
  summary: string
  layers: ArchitectureLayer[]
  platforms: Array<{
    id: string
    label: string
    description: string
    technology: string
    componentNodeIds: string[]
    toolings?: Array<{
      id: string
      label: string
      description: string
      technology: string
      componentNodeId: string
    }>
    provenance: 'confirmed' | 'assumed'
  }>
  workflow: {
    actor: string
    goal: string
    steps: Array<{
      id: string
      order: number
      label: string
      userAction: string
      platformCalls: Array<{
        platformId: string
        toolingId: string
        nodeId: string
        action: string
        mechanism: string
        output: string
      }>
    }>
  }
  connections: Array<{
    from: string
    to: string
    label: string
    type: 'request' | 'event' | 'data' | 'auth'
    mechanism: string
    payload: string
    provenance: 'confirmed' | 'assumed'
    primary: boolean
    evidencePaths?: string[]
  }>
  assumptions: string[]
}

export interface ArchitectureVisualLayout {
  width: 1600
  height: 900
  nodes: Array<{
    id: string
    x: number
    y: number
    width: number
    height: number
  }>
  connections: Array<{
    from: string
    to: string
    points: Array<{ x: number; y: number }>
    labelX: number
    labelY: number
  }>
}

export interface ArchitectureVisual {
  mode: 'dual' | ArchitectureVisualMode | 'legacy'
  imageUrl?: string
  visualPoints?: string[]
  pptxDownloadUrl?: string
  pptxGenerateUrl?: string
  narrativeImageUrl?: string
  htmlUrl?: string
  validatedJsonHtmlUrl?: string
  imageDerivedHtmlUrl?: string
  narrativeHtmlUrl?: string
  layout?: ArchitectureVisualLayout
  fallbackReason?: string
  failures?: Array<{ mode: ArchitectureVisualMode; error: string }>
}

export type ArchitectureVisualMode =
  | 'html'
  | 'image'
  | 'narrative-image'
  | 'narrative-html'
  | 'validated-json-html'
  | 'image-html'

export type SlideKind =
  | 'title'
  | 'problem'
  | 'user-scenarios'
  | 'solution'
  | 'architecture'
  | 'summary'

export interface SpeechScript {
  title: string
  notes: Array<{
    slideId: string
    slideTitle: string
    script: string
  }>
}

export interface Slide {
  id: string
  kind: SlideKind
  eyebrow: string
  title: string
  subtitle: string
  bullets: string[]
  imageUrl?: string
}

export interface SlideDeck {
  title: string
  subtitle: string
  theme: 'midnight' | 'azure' | 'paper'
  slides: Slide[]
}

export interface SlideGenerationResult {
  deck: SlideDeck
  previewUrl: string
  downloadUrl: string
  pptxDownloadUrl: string
  pptxGenerateUrl: string
}

export interface SlideGenerationProgress {
  status: 'idle' | 'running' | 'completed' | 'failed'
  percent: number
  stage: string
  log: string
  completedSlides: number
  totalSlides: number
  startedAt?: string
  error?: string
}

export interface ProjectAsset {
  id: string
  type: string
  format: string
  revision: number
  relativePath: string
  createdAt: string
  sourceAssetIds: string[]
  metadata: Record<string, string | number | boolean | null>
}

export interface PresentationProject {
  id: string
  createdAt: string
  updatedAt: string
  brief: PresentationBrief
  assets: ProjectAsset[]
  currentAssets: Record<string, string | undefined>
}

export interface RepositoryEvidenceSummary {
  repository: {
    owner: string
    name: string
    url: string
    commitSha: string
    private: boolean
  }
  scan: {
    selectedFileCount: number
    truncated: boolean
  }
  technologies: string[]
  warnings: string[]
}

export interface VideoMetadata {
  container: string
  duration: number
  sizeBytes: number
  video: {
    codec: string
    width: number
    height: number
    frameRate: number
    pixelFormat: string
  }
  audio: {
    codec: string
    sampleRate: number
    channels: number
  } | null
  keyframes: {
    count: number
    firstTimestamps: number[]
  }
}

export interface VideoRefinementOptions {
  targetSpeed: number
  minimumInactiveDuration: number
  clarity: 'none' | 'standard' | 'strong'
  resolution: 'source' | '1080p' | '4k'
}

export interface UploadedRecording {
  asset: ProjectAsset
  filename: string
  sizeBytes: number
}

export interface VideoRefinementResult {
  jobId: string
  source: VideoMetadata
  output: {
    metadata: VideoMetadata
    downloadUrl: string
  }
  processing: {
    acceleratedRanges: Array<{
      start: number
      end: number
      speed: number
      originalDuration: number
      outputDuration: number
    }>
    filters: string[]
    originalDuration: number
    outputDuration: number
    durationChange: number
    warnings: string[]
  }
}
