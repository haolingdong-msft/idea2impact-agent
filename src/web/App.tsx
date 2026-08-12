import './App.css'
import { useEffect, useState } from 'react'
import { ArchitectureCanvas } from './components/ArchitectureCanvas'
import { ChatWindow } from './components/ChatWindow'
import { IdeaBrief } from './components/IdeaBrief'
import { MessageInput } from './components/MessageInput'
import { SlideWorkspace } from './components/SlideWorkspace'
import { StoryApproval } from './components/StoryApproval'
import { VideoWorkspace } from './components/VideoWorkspace'
import { WorkflowRail } from './components/WorkflowRail'
import { useArchitecture } from './hooks/useArchitecture'
import { useProject } from './hooks/useProject'
import { useService } from './hooks/useService'
import { useSlides } from './hooks/useSlides'
import { useRepository } from './hooks/useRepository'
import { useGitHubAuth } from './hooks/useGitHubAuth'
import {
  isStoryApprovalMessage,
  nextStorySection,
  storyApprovalsFromMessages,
} from './story-approval'
import type { ArchitectureVisualMode, PresentationBrief, StorySection } from './types'

export default function App() {
  const { messages, isLoading, sendMessage, resetConversation } = useService()
  const { architecture, visual, isGenerating, error, generateArchitecture } = useArchitecture()
  const {
    project,
    isSaving,
    error: projectError,
    createPresentationProject,
    saveApprovedStory,
  } = useProject()
  const {
    result: slideResult,
    isGenerating: isGeneratingSlides,
    error: slideError,
    generateSlides,
    clearSlides,
  } = useSlides()
  const [brief, setBrief] = useState<PresentationBrief | null>(null)
  const [approvedSections, setApprovedSections] = useState<StorySection[]>([])
  const [lastApprovalAssistantCount, setLastApprovalAssistantCount] = useState(0)
  const [quickStatus, setQuickStatus] = useState<string | null>(null)
  const [quickError, setQuickError] = useState<string | null>(null)
  const [architectureView, setArchitectureView] = useState<ArchitectureVisualMode>('image')
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
      const createdProject = await createPresentationProject(nextBrief)
      setBrief(nextBrief)
      setApprovedSections([])
      setLastApprovalAssistantCount(0)
      if (nextBrief.repositoryUrl) {
        try {
          await scanRepository(createdProject.id, nextBrief.repositoryUrl)
        } catch {
          // Continue into clarification and show the scan error in the workspace.
        }
      }
      await sendMessage(nextBrief.idea, nextBrief, createdProject.id)
    } catch {
      // The project hook exposes the actionable error beside the brief.
    }
  }

  const quickGeneratePresentation = async (nextBrief: PresentationBrief) => {
    setQuickError(null)
    try {
      resetConversation()
      clearSlides()
      setQuickStatus('Creating presentation project...')
      const createdProject = await createPresentationProject(nextBrief)
      setBrief(nextBrief)
      setApprovedSections(['problem', 'userStory', 'architecture'])
      if (nextBrief.repositoryUrl) {
        setQuickStatus('Scanning codebase for architecture evidence...')
        await scanRepository(createdProject.id, nextBrief.repositoryUrl)
      }
      const directContext = [
        'Quick generation mode: derive the Problem Statement, User Story, and high-level Architecture directly from the supplied idea and optional codebase evidence.',
        `Idea: ${nextBrief.idea}`,
        `Audience: ${nextBrief.audience || 'Not specified'}`,
        `Purpose: ${nextBrief.purpose || 'Not specified'}`,
      ].join('\n')
      setQuickStatus('Preparing grounded presentation story...')
      await saveApprovedStory(
        createdProject.id,
        directContext,
        ['problem', 'userStory', 'architecture'],
      )
      setQuickStatus('Generating HTML/CSS and image-model architecture designs...')
      await generateArchitecture(nextBrief, directContext, createdProject.id, true)
      setQuickStatus('Composing slide deck...')
      await generateSlides(createdProject.id, architectureView)
      setQuickStatus(null)
    } catch (caught) {
      setQuickStatus(null)
      setQuickError(
        caught instanceof Error ? caught.message : 'Quick slide generation failed.',
      )
    }
  }

  const approveSection = async (section: StorySection) => {
    const assistantCount = messages.filter(
      message => message.role === 'assistant' && message.content.trim(),
    ).length
    setLastApprovalAssistantCount(assistantCount)
    setApprovedSections(current => current.includes(section) ? current : [...current, section])
    const nextPrompt: Record<StorySection, string> = {
      problem: 'I approve the Problem Statement. Continue to the User Story, summarize it, and ask for approval.',
      userStory: 'I approve the User Story. Continue to the Architecture, summarize it, and ask for approval.',
      architecture: 'I approve the Architecture. Provide the final narrative summary grounded in all three approved sections.',
    }
    await sendMessage(nextPrompt[section], undefined, project?.id)
  }

  const generateApprovedArchitecture = async () => {
    if (!brief || !project || approvedSections.length !== 3) return
    const context = messages
      .filter(message => message.role !== 'error' && message.content.trim())
      .map(message => `${message.role.toUpperCase()}: ${message.content}`)
      .join('\n\n')
    try {
      clearSlides()
      await saveApprovedStory(project.id, context, approvedSections)
      await generateArchitecture(brief, context, project.id, false)
    } catch {
      // Storage and generation hooks expose errors in the workspace.
    }
  }

  const generateApprovedSlides = async () => {
    if (!brief || !project) return
    const context = messages
      .filter(message => message.role !== 'error' && message.content.trim())
      .map(message => `${message.role.toUpperCase()}: ${message.content}`)
      .join('\n\n')
    try {
      await generateArchitecture(brief, context, project.id, true)
      await generateSlides(project.id, architectureView)
    } catch {
      // The slide hook exposes the actionable error in the slide workspace.
    }
  }

  const generateApprovedPresentation = async () => {
    if (!brief || !project || approvedSections.length !== 3) return
    const context = messages
      .filter(message => message.role !== 'error' && message.content.trim())
      .map(message => `${message.role.toUpperCase()}: ${message.content}`)
      .join('\n\n')
    try {
      clearSlides()
      await saveApprovedStory(project.id, context, approvedSections)
      await generateArchitecture(brief, context, project.id, true)
      await generateSlides(project.id, architectureView)
    } catch {
      // The project, architecture, and slide hooks expose actionable errors.
    }
  }

  const hasAssistantResponse = messages.some(
    message => message.role === 'assistant' && message.content.trim().length > 0,
  )
  const assistantResponseCount = messages.filter(
    message => message.role === 'assistant' && message.content.trim(),
  ).length
  const approvalReady = hasAssistantResponse &&
    assistantResponseCount > lastApprovalAssistantCount &&
    !isLoading

  useEffect(() => {
    const approvals = storyApprovalsFromMessages(
      messages
        .filter(message => message.role === 'user')
        .map(message => message.content),
    )
    setApprovedSections(current =>
      approvals.length > current.length ? approvals : current)
  }, [messages])

  const sendStoryMessage = async (message: string) => {
    if (slideResult) {
      await sendMessage(message, undefined, project?.id, 'refinement')
      return
    }
    const nextSection = nextStorySection(approvedSections)
    if (
      nextSection &&
      approvalReady &&
      isStoryApprovalMessage(message, nextSection)
    ) {
      await approveSection(nextSection)
      return
    }
    await sendMessage(message, undefined, project?.id)
  }

  const activeStep = slideResult ? 4 : architecture ? 3 : brief ? 1 : 0

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
            {brief && architecture && (
              <button className="ghost-button" onClick={() => void generateApprovedArchitecture()}>
                Regenerate graph
              </button>
            )}
          </div>
        </header>
        {quickStatus && <p className="quick-status" role="status">{quickStatus}</p>}
        {quickError && <p className="project-error" role="alert">{quickError}</p>}

        {!brief ? (
          <>
            <div className="onboarding-layout">
              <div>
                <IdeaBrief
                  isLoading={isGenerating || isLoading || isSaving || isScanning}
                  onSubmit={briefValue => void startProject(briefValue)}
                  onQuickGenerate={briefValue => void quickGeneratePresentation(briefValue)}
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
            <div className="project-layout">
              <div className="canvas-panel">
                <ArchitectureCanvas
                  architecture={architecture}
                  visual={visual}
                  isLoading={isGenerating}
                  error={error}
                  selectedMode={architectureView}
                  onSelectedModeChange={setArchitectureView}
                />
              </div>
              <aside className="copilot-panel">
                <header>
                  <div className="copilot-avatar">C</div>
                  <div>
                    <strong>Story copilot</strong>
                    <span>Problem / User / Architecture</span>
                  </div>
                </header>
                <StoryApproval
                  approved={approvedSections}
                  canApprove={approvalReady}
                  isGenerating={isGenerating || isGeneratingSlides}
                  isRefining={Boolean(slideResult)}
                  onApprove={section => void approveSection(section)}
                  onGenerate={() => void generateApprovedPresentation()}
                />
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
                <ChatWindow messages={messages} isStreaming={isLoading} />
                <MessageInput
                  onSend={message => void sendStoryMessage(message)}
                  disabled={isLoading}
                />
              </aside>
            </div>
            {architecture && (
              <SlideWorkspace
                architecture={architecture}
                visual={visual}
                result={slideResult}
                isGenerating={isGenerating || isGeneratingSlides}
                error={slideError}
                architectureMode={architectureView}
                onArchitectureModeChange={setArchitectureView}
                onGenerate={() => void generateApprovedSlides()}
              />
            )}
            {slideResult && <VideoWorkspace projectId={project?.id} />}
          </>
        )}
      </main>
    </div>
  )
}
