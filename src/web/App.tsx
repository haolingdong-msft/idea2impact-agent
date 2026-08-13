import './App.css'
import { useState } from 'react'
import { ArchitectureCanvas } from './components/ArchitectureCanvas'
import { ChatWindow } from './components/ChatWindow'
import { IdeaBrief } from './components/IdeaBrief'
import { MessageInput } from './components/MessageInput'
import { OutlineWorkspace } from './components/OutlineWorkspace'
import { SlideWorkspace } from './components/SlideWorkspace'
import { SpeechWorkspace } from './components/SpeechWorkspace'
import { VideoWorkspace } from './components/VideoWorkspace'
import { WorkflowRail } from './components/WorkflowRail'
import { useArchitecture } from './hooks/useArchitecture'
import { useProject } from './hooks/useProject'
import { useService } from './hooks/useService'
import { useSlides } from './hooks/useSlides'
import { useRepository } from './hooks/useRepository'
import { useGitHubAuth } from './hooks/useGitHubAuth'
import { useOutline } from './hooks/useOutline'
import { useSpeechScript } from './hooks/useSpeechScript'
import type { ArchitectureVisualMode, PresentationBrief } from './types'

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
    createPresentationProject,
  } = useProject()
  const {
    outline,
    isGenerating: isGeneratingOutline,
    isSaving: isSavingOutline,
    error: outlineError,
    generateOutline,
    updateOutline,
    approveOutline,
    resetOutline,
  } = useOutline()
  const {
    result: slideResult,
    isGenerating: isGeneratingSlides,
    error: slideError,
    generateSlides,
    clearSlides,
  } = useSlides()
  const {
    script,
    setScript,
    isGenerating: isGeneratingSpeech,
    isSaving: isSavingSpeech,
    error: speechError,
    generateScript,
    saveScript,
    clearScript,
  } = useSpeechScript()
  const [brief, setBrief] = useState<PresentationBrief | null>(null)
  const [architectureView, setArchitectureView] = useState<ArchitectureVisualMode>('image')
  const [recordingUploaded, setRecordingUploaded] = useState(false)
  const [recordingRefined, setRecordingRefined] = useState(false)
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
    const updatedMessages = await sendMessage(
      message,
      undefined,
      project.id,
      slideResult ? 'refinement' : 'initial',
    )
    if (updatedMessages) {
      await generateOutline(project.id, updatedMessages)
      clearSlides()
      clearScript()
      setRecordingUploaded(false)
      setRecordingRefined(false)
    }
  }

  const quickTestCodebase = async (nextBrief: PresentationBrief) => {
    if (!nextBrief.repositoryUrl) return
    setQuickError(null)
    try {
      resetConversation()
      resetOutline()
      clearSlides()
      clearScript()
      setRecordingUploaded(false)
      setRecordingRefined(false)
      setQuickStatus('Creating project...')
      const createdProject = await createPresentationProject(nextBrief)
      setBrief(nextBrief)
      setQuickStatus('Scanning codebase...')
      await scanRepository(createdProject.id, nextBrief.repositoryUrl)
      setQuickStatus('Generating codebase-grounded outline...')
      const draft = await generateOutline(createdProject.id, [])
      setQuickStatus('Locking quick-test outline revision...')
      const approved = await approveOutline(createdProject.id, draft)
      setQuickStatus('Generating architecture designs...')
      await generateArchitecture(
        nextBrief,
        JSON.stringify(approved),
        createdProject.id,
        true,
      )
      setQuickStatus('Generating slides...')
      await generateSlides(createdProject.id, architectureView)
      setQuickStatus(null)
    } catch (caught) {
      setQuickStatus(null)
      setQuickError(
        caught instanceof Error ? caught.message : 'Codebase quick test failed.',
      )
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

  const generateApprovedPresentation = async () => {
    if (!brief || !project || outline?.status !== 'approved') return
    setQuickError(null)
    try {
      clearSlides()
      clearScript()
      setRecordingUploaded(false)
      setRecordingRefined(false)
      const context = JSON.stringify(outline)
      setQuickStatus('Generating architecture design...')
      await generateArchitecture(brief, context, project.id, true)
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

  const outlineComplete = Boolean(
    outline &&
    outline.problemStatement.trim().length >= 20 &&
    outline.userScenarios.trim().length >= 20 &&
    outline.solution.trim().length >= 20,
  )
  const activeStep = !brief
    ? 0
    : outline?.status !== 'approved'
      ? outlineComplete ? 3 : outline ? 2 : 1
      : !slideResult
        ? 4
        : !script
          ? 5
          : !recordingUploaded
            ? 6
            : !recordingRefined
              ? 7
              : 8
  const outlineBusy =
    isLoading ||
    isGeneratingOutline ||
    isGenerating ||
    isGeneratingSlides ||
    isGeneratingSpeech

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Presentation Agent home">
          <span>PA</span>
          <div>
            <strong>Presentation</strong>
            <small>Agent workspace</small>
          </div>
        </a>
        <WorkflowRail activeStep={activeStep} />
        <div className="sidebar-note">
          <span>Powered by</span>
          <strong>GitHub Copilot SDK</strong>
          <small>Orchestrated asset release</small>
        </div>
      </aside>

      <main className="main-workspace">
        <header className="workspace-header">
          <div>
            <span className="eyebrow">Presentation workspace / Orchestrated assets</span>
            <h1>{brief?.title || 'Turn an idea into a clear system story'}</h1>
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
                  onQuickTest={briefValue => void quickTestCodebase(briefValue)}
                  githubStatus={githubStatus}
                  onGitHubLogout={() => void logoutGitHub()}
                />
                {projectError && <p className="project-error" role="alert">{projectError}</p>}
              </div>
              <ArchitectureCanvas architecture={null} visual={null} isLoading={false} error={null} />
            </div>
            <VideoWorkspace standalone />
          </>
        ) : (
          <>
            <div className="project-layout outline-project-layout">
              <div className="canvas-panel">
                <OutlineWorkspace
                  outline={outline}
                  isBusy={outlineBusy}
                  isSaving={isSavingOutline}
                  error={outlineError || error || slideError}
                  onChange={value => project && updateOutline(project.id, value)}
                  onApprove={() => void approveCurrentOutline()}
                  onGenerate={() => void generateApprovedPresentation()}
                />
              </div>
              <aside className="copilot-panel">
                <header>
                  <div className="copilot-avatar">C</div>
                  <div>
                    <strong>Outline copilot</strong>
                    <span>Problem / Scenarios / Solution</span>
                  </div>
                </header>
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
                isGenerating={isGenerating || isGeneratingSlides}
                error={slideError}
                architectureMode={architectureView}
                onArchitectureModeChange={setArchitectureView}
                onGenerate={() => void generateApprovedPresentation()}
              />
            )}
            {slideResult && (
              <SpeechWorkspace
                script={script}
                isGenerating={isGeneratingSpeech}
                isSaving={isSavingSpeech}
                error={speechError}
                onGenerate={() => void generateScript(project.id)}
                onChange={setScript}
                onSave={() => script && void saveScript(project.id, script)}
              />
            )}
            {script && (
              <VideoWorkspace
                projectId={project.id}
                onUploadComplete={() => setRecordingUploaded(true)}
                onRefinementComplete={() => setRecordingRefined(true)}
              />
            )}
          </>
        )}
      </main>
    </div>
  )
}
