import './App.css'
import { useState } from 'react'
import { ArchitectureCanvas } from './components/ArchitectureCanvas'
import { ChatWindow } from './components/ChatWindow'
import { IdeaBrief } from './components/IdeaBrief'
import { MessageInput } from './components/MessageInput'
import { OutlineWorkspace } from './components/OutlineWorkspace'
import { SlideWorkspace } from './components/SlideWorkspace'
import { SlideVideoWorkspace } from './components/SlideVideoWorkspace'
import { VideoWorkspace } from './components/VideoWorkspace'
import { WorkflowRail } from './components/WorkflowRail'
import { useArchitecture } from './hooks/useArchitecture'
import { useProject } from './hooks/useProject'
import { useService } from './hooks/useService'
import { useSlides } from './hooks/useSlides'
import { useRepository } from './hooks/useRepository'
import { useGitHubAuth } from './hooks/useGitHubAuth'
import { useOutline } from './hooks/useOutline'
import type { ArchitectureVisualMode, PresentationBrief } from './types'

const COPILOT_WORKFLOW_CONTEXTS = [
  {
    label: 'Start story',
    subtitle: 'Editing the shared story',
    placeholder: 'Ask Copilot to refine the problem, scenarios, or solution...',
  },
  {
    label: 'Generate overview image',
    subtitle: 'Editing overview image direction',
    placeholder: 'Describe what to change in the overview image...',
  },
  {
    label: 'Generate slides',
    subtitle: 'Editing slide content and direction',
    placeholder: 'Describe what to change in the slides...',
  },
  {
    label: 'Generate video',
    subtitle: 'Editing video narrative and direction',
    placeholder: 'Describe what to change in the video...',
  },
] as const

export default function App() {
  const { messages, isLoading, sendMessage, resetConversation } = useService()
  const {
    architecture,
    visual,
    progress: architectureProgress,
    isGenerating,
    error,
    generateArchitecture,
  } = useArchitecture()
  const {
    project,
    isSaving: isSavingProject,
    error: projectError,
    clearError: clearProjectError,
    createPresentationProject,
  } = useProject()
  const {
    outline,
    isGenerating: isGeneratingOutline,
    isSaving: isSavingOutline,
    isApproving: isApprovingOutline,
    error: outlineError,
    generateOutline,
    updateOutline,
    approveOutline,
    resetOutline,
  } = useOutline()
  const {
    result: slideResult,
    progress: slideProgress,
    isGenerating: isGeneratingSlides,
    error: slideError,
    generateSlides,
    clearSlides,
  } = useSlides()
  const [brief, setBrief] = useState<PresentationBrief | null>(null)
  const [architectureView, setArchitectureView] = useState<ArchitectureVisualMode>('image')
  const [videoGenerated, setVideoGenerated] = useState(false)
  const [showSlideVideo, setShowSlideVideo] = useState(false)
  const [copilotWorkflowStep, setCopilotWorkflowStep] = useState(0)
  const [quickStatus, setQuickStatus] = useState<string | null>(null)
  const [quickError, setQuickError] = useState<string | null>(null)
  const {
    evidence: repositoryEvidence,
    isScanning,
    error: repositoryError,
    scanRepository,
  } = useRepository()
  const {
    status: githubStatus,
    logout: logoutGitHub,
  } = useGitHubAuth()

  const startProject = async (nextBrief: PresentationBrief) => {
    try {
      resetConversation()
      resetOutline()
      clearSlides()
      const createdProject = await createPresentationProject(nextBrief)
      setBrief(nextBrief)
      if (nextBrief.repositoryUrl) {
        try {
          await scanRepository(createdProject.id, nextBrief.repositoryUrl)
        } catch {
          // Continue with the user brief; the repository error remains visible.
        }
      }
      await generateOutline(createdProject.id, [])
      await sendMessage(nextBrief.idea, nextBrief, createdProject.id)
    } catch {
      // Hooks expose actionable errors in the workspace.
    }
  }

  const sendOutlineMessage = async (message: string) => {
    if (!project) return
    const context = COPILOT_WORKFLOW_CONTEXTS[copilotWorkflowStep]
    const updatedMessages = await sendMessage(
      message,
      undefined,
      project.id,
      slideResult ? 'refinement' : 'initial',
      [
        `The user is editing the "${context.label}" workflow stage.`,
        'Apply the request to the shared presentation story so downstream assets can be regenerated consistently.',
      ].join(' '),
    )
    if (updatedMessages) {
      await generateOutline(project.id, updatedMessages)
      clearSlides()
      setVideoGenerated(false)
    }
  }

  const approveCurrentOutline = async () => {
    if (!project) return
    try {
      await approveOutline(project.id)
    } catch {
      // The outline hook exposes the approval error.
    }
  }

  const generateOverview = async () => {
    if (!brief || !project || outline?.status !== 'approved') return
    setQuickError(null)
    try {
      clearSlides()
      setVideoGenerated(false)
      const context = JSON.stringify(outline)
      setQuickStatus('Generating overview image...')
      await generateArchitecture(brief, context, project.id, true)
      setQuickStatus(null)
    } catch (caught) {
      setQuickStatus(null)
      setQuickError(
        caught instanceof Error ? caught.message : 'Overview generation failed.',
      )
    }
  }

  const generateSlideDeck = async () => {
    if (!project || !architecture || outline?.status !== 'approved') return
    setQuickError(null)
    try {
      setShowSlideVideo(false)
      clearSlides()
      setVideoGenerated(false)
      setQuickStatus('Composing slide deck...')
      await generateSlides(project.id, architectureView)
      setQuickStatus(null)
    } catch (caught) {
      setQuickStatus(null)
      setQuickError(
        caught instanceof Error ? caught.message : 'Slide generation failed.',
      )
    }
  }

  const activeStep = !brief
    ? 0
    : outline?.status !== 'approved'
      ? 0
      : !architecture
        ? 1
        : !slideResult
          ? 2
          : videoGenerated
            ? 4
            : 3
  const outlineBusy =
    isLoading ||
    isGeneratingOutline ||
    isGenerating ||
    isGeneratingSlides
  const openCopilotForStep = (step: number) => {
    setCopilotWorkflowStep(step)
    window.requestAnimationFrame(() => {
      const target = brief
        ? document.getElementById('copilot-panel')
        : document.querySelector<HTMLElement>('.brief-card')
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      target?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
    })
  }
  const copilotContext = COPILOT_WORKFLOW_CONTEXTS[copilotWorkflowStep]

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Idea2Impact Agent home">
          <span>I2I</span>
          <div>
            <strong>Idea2Impact</strong>
            <small>Agent studio</small>
          </div>
        </a>
        <WorkflowRail
          activeStep={activeStep}
          selectedStep={copilotWorkflowStep}
          onSelect={openCopilotForStep}
        />
        <div className="sidebar-note">
          <span>Powered by</span>
          <strong>Microsoft Foundry and GitHub Copilot</strong>
          <small>Orchestrated asset release</small>
        </div>
      </aside>

      <main className="main-workspace">
        <header className="workspace-header">
          <div>
            <span className="eyebrow">Idea2Impact workspace / Orchestrated assets</span>
            <h1>{brief?.title || 'Turn your idea into a story people remember'}</h1>
          </div>
          <div className="header-actions">
            <span className="status-pill"><i /> Workspace ready</span>
          </div>
        </header>
        {quickStatus && <p className="quick-status" role="status">{quickStatus}</p>}
        {architectureProgress && architectureProgress.status !== 'idle' && (
          <section
            className={`generation-progress ${architectureProgress.status}`}
            aria-live="polite"
          >
            <div className="generation-progress-heading">
              <strong>{architectureProgress.stage}</strong>
              <span>{architectureProgress.percent}%</span>
            </div>
            <progress max="100" value={architectureProgress.percent} />
            <div className="generation-task-list">
              {architectureProgress.tasks.map(task => (
                <span
                  className={task.status}
                  key={task.id}
                  title={task.error}
                >
                  <i />
                  {task.label}
                  {task.status === 'failed' ? ` — ${task.error}` : ''}
                </span>
              ))}
            </div>
            {architectureProgress.startedAt && (
              <small>
                Started {new Date(architectureProgress.startedAt).toLocaleTimeString()}
                {' · '}
                {architectureProgress.completedTasks}/{architectureProgress.totalTasks} designs complete
              </small>
            )}
            {architectureProgress.error && (
              <p role="alert">{architectureProgress.error}</p>
            )}
          </section>
        )}
        {quickError && <p className="project-error" role="alert">{quickError}</p>}

        {!brief ? (
          <>
            <div className="onboarding-layout">
              <div>
                <IdeaBrief
                  isLoading={isSavingProject || isScanning || isLoading || isGeneratingOutline}
                  onSubmit={briefValue => void startProject(briefValue)}
                  onEdit={clearProjectError}
                  githubStatus={githubStatus}
                  onGitHubLogout={() => void logoutGitHub()}
                />
                {projectError && <p className="project-error" role="alert">{projectError}</p>}
              </div>
              <ArchitectureCanvas architecture={null} visual={null} isLoading={false} error={null} />
            </div>
            <SlideVideoWorkspace />
            <VideoWorkspace standalone />
          </>
        ) : (
          <>
            <div className="project-layout outline-project-layout">
              <div className="canvas-panel">
                <OutlineWorkspace
                  outline={outline}
                  isBusy={outlineBusy}
                  isGeneratingOutline={isGeneratingOutline}
                  isApproving={isApprovingOutline}
                  isSaving={isSavingOutline}
                  error={outlineError || error || slideError}
                  isGeneratingOverview={isGenerating}
                  onChange={value => project && updateOutline(project.id, value)}
                  onApprove={() => void approveCurrentOutline()}
                  onGenerateOverview={() => void generateOverview()}
                />
              </div>
              <aside className="copilot-panel" id="copilot-panel">
                <header>
                  <div className="copilot-avatar">AI</div>
                  <div>
                    <strong>Idea2Impact Copilot</strong>
                    <span>{copilotContext.subtitle}</span>
                  </div>
                </header>
                <div className="copilot-workflow-context">
                  <span>Workflow context</span>
                  <strong>{copilotContext.label}</strong>
                </div>
                {repositoryEvidence && (
                  <div className="repository-status">
                    <strong>{repositoryEvidence.repository.owner}/{repositoryEvidence.repository.name}</strong>
                    <span>
                      {repositoryEvidence.scan.selectedFileCount} cited files /{' '}
                      {repositoryEvidence.repository.commitSha.slice(0, 7)}
                    </span>
                  </div>
                )}
                {repositoryError && (
                  <p className="project-error" role="alert">{repositoryError}</p>
                )}
                <ChatWindow messages={messages} isStreaming={isLoading || isGeneratingOutline} />
                <MessageInput
                  onSend={message => void sendOutlineMessage(message)}
                  disabled={isLoading || isGeneratingOutline}
                  placeholder={copilotContext.placeholder}
                />
              </aside>
            </div>

            {architecture && (
              <section className="generated-architecture-section">
                <ArchitectureCanvas
                  architecture={architecture}
                  visual={visual}
                  isLoading={isGenerating}
                  error={error}
                  selectedMode={architectureView}
                  onSelectedModeChange={setArchitectureView}
                />
              </section>
            )}

            {architecture && (
              <SlideWorkspace
                architecture={architecture}
                visual={visual}
                result={slideResult}
                progress={slideProgress}
                isGenerating={isGenerating || isGeneratingSlides}
                error={slideError}
                architectureMode={architectureView}
                onArchitectureModeChange={setArchitectureView}
                onGenerate={() => void generateSlideDeck()}
                onCreateVideo={() => setShowSlideVideo(true)}
              />
            )}
            {slideResult && showSlideVideo && (
              <SlideVideoWorkspace
                sourceUrl={slideResult.downloadUrl}
                sourceName={`${slideResult.deck.title} HTML deck`}
                autoStart
                onComplete={() => setVideoGenerated(true)}
              />
            )}
          </>
        )}
      </main>
    </div>
  )
}
