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

export type StorySection = 'problem' | 'userStory' | 'architecture'

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

export type SlideKind =
  | 'title'
  | 'problem'
  | 'user-story'
  | 'architecture'
  | 'summary'

export interface Slide {
  id: string
  kind: SlideKind
  eyebrow: string
  title: string
  subtitle: string
  bullets: string[]
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
