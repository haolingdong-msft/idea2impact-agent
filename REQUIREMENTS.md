# Presentation Agent — Requirements Document

## 1. Overview

The **Presentation Agent** is a web application powered by the **GitHub Copilot
SDK** that helps users produce high-quality technical presentation assets
end-to-end. It turns an idea into an editable three-part outline and architecture
graph, turns one approved outline into presentation slides and slide-grounded
speaker notes, then turns an uploaded recording into a refined video. Every step contributes versioned
assets to one orchestrated presentation project. Azure AI Foundry provides
optional speech and video models rather than the primary agent runtime.

The agent is designed to be **modular and extensible**: each capability is exposed
as an independent tool/skill so that new features can be added over time without
reworking the core agent.

- **Primary agent runtime:** GitHub Copilot SDK hosted in a custom Node container
  on Microsoft Foundry Hosted Agents
- **Web experience:** React and TypeScript
- **Application services:** Azure Container Apps for the web UI, project API,
  slide rendering, durable asset access, and deterministic FFmpeg processing
- **Optional media models:** Azure AI Foundry
- **Optional Foundry project:** [foundry-haoling-eus2 / proj-default](https://ai.azure.com/nextgen/r/-qCAr8HYQK2czuGkUMpbVw,rg-haoling,,foundry-haoling-eus2,proj-default/build/agents?tid=72f988bf-86f1-41af-91ab-2d7cd011db47)
- **Resource group:** rg-haoling
- **Region:** East US 2

## 2. Goals & Non-Goals

### 2.1 Goals
- Provide a single conversational agent that orchestrates multiple presentation
  authoring tools.
- Create a clear, responsive HTML architecture graph from a user brief and
  supporting content.
- Generate a reviewable slide deck from the approved outline and architecture,
  with HTML as the required format and `.pptx` as an optional export.
- Improve recordings by speeding up hanging or inactive parts and enhancing
  visual clarity.
- Transcribe demo recordings and refine the spoken content into a concise script
  that the user can edit or approve.
- Generate narration from text in the user's own voice, with explicit consent.
- Synchronize approved personal-voice narration with the edited video.
- Maintain project-level asset lineage across the brief, approvals, architecture,
  slides, source video, refined video, script, voice assets, and narration.
- Deliver outputs in standard formats (HTML/JSON, optional PPTX, MP4, WAV/MP3).
- Support incremental addition of new capabilities (plugin-style tools).

### 2.2 Non-Goals (initial release)
- Pixel-perfect editing of arbitrary existing PowerPoint decks; the initial
  release generates a new HTML deck and may optionally export `.pptx`.
- Full-blown non-linear video editing (the initial release focuses on automated
  pacing, picture enhancement, and narration).
- Real-time / live presentation delivery or teleprompting.
- Multi-language translation of narration (candidate for a future feature).

## 3. Personas & Use Cases

| Persona | Use case |
|---------|----------|
| Engineer / Architect | "Turn my system description into a clear architecture graph." |
| Presenter | "Speed up the parts where my recording hangs and make the video clearer." |
| Content creator | "Narrate this script using my own voice." |

## 4. Functional Requirements

### 4.1 Feature 1 — Structure Story, Create Architecture, and Generate Slides

**Description:** Create a well-structured, professional architecture graph from a
user brief and optional source documents. The agent uses three inputs:
**Problem Statement**, **User Scenarios**, and **Solution**. It works
conversationally with the user to refine all three parts, displays one editable
outline summary, and requires one combined approval before generation.

**Requirements:**
- FR-1.1: Accept a natural-language brief containing the topic, audience, purpose,
  and desired outcome.
- FR-1.1a: Require only the natural-language idea. Title, audience, purpose, and
  GitHub repository URL are optional and must not block project creation.
- FR-1.1aa: When no repository is supplied, immediately generate initial Problem
  Statement, User Scenarios, and Solution content from the user's idea, optional
  audience, and optional purpose. Do not require a clarification answer before
  showing all three fields; subsequent chat refines the generated draft.
- FR-1.1b: When a GitHub repository URL is supplied, scan a bounded,
  architecture-focused set of code and documentation at a pinned commit and use
  the resulting cited evidence to ground the story, graph, and slides.
- FR-1.1e: After a repository scan, automatically summarize the codebase into the
  initial Problem Statement, User Scenarios, and Solution fields. The user does
  not need to separately describe those fields before the first outline appears.
- FR-1.1f: Derive technical behavior and workflows from repository evidence, but
  label product intent, business impact, or target-user claims that the codebase
  cannot prove as assumptions.
- FR-1.1c: Support public repositories without login and private repositories
  through a least-privilege GitHub App installed on repositories selected by the
  current user.
- FR-1.1d: Never execute repository code or persist GitHub tokens, complete
  repository archives, or unbounded source files.
- FR-1.2: Accept optional source material such as text, Markdown, PDFs, images, or
  an existing architecture specification.
- FR-1.3: Conduct a guided conversation to clarify the **Problem Statement**,
  including the current situation, target users, pain points, impact, evidence,
  scope, and desired outcome.
- FR-1.4: Conduct a guided conversation to clarify **User Scenarios**, including
  primary actors, workflows, expected value, success criteria, and important edge
  cases.
- FR-1.5: Conduct a guided conversation to clarify the **Solution**, including
  experience, capabilities, system boundaries, components, integrations, data flow,
  deployment environment, security constraints, and non-functional requirements.
- FR-1.6: Do not require approval after individual sections. Keep all three sections
  synchronized in one structured outline throughout the conversation.
- FR-1.7: Present the complete outline prominently in the center of the workspace.
  The user can edit it directly or update it through the agent.
- FR-1.7a: Autosave direct edits as versioned draft outline assets.
- FR-1.7b: Provide one combined approval action. Approval creates an immutable
  approved outline revision used by all downstream generation.
- FR-1.7c: Provide a repository-only **Quick test: generate slides** shortcut for
  manual smoke testing. Its click explicitly authorizes the application to scan
  the repository, generate and lock the initial outline revision, and continue
  directly through architecture and slide generation.
- FR-1.8: Generate a graph title, one-sentence summary, architecture layers,
  components, and labeled connections appropriate for the intended audience.
- FR-1.8a: Describe each technical component with its runtime or implementation
  technology, responsibility, and whether that detail was user-confirmed or
  inferred.
- FR-1.8b: Describe each component relationship with direction, interaction type,
  protocol or mechanism, and the command, event, or data exchanged.
- FR-1.8c: For every runtime platform, list only the important toolings or
  capabilities hosted or used there (for example GitHub file read, Foundry Hosted
  Agent, agent trace, and agent trace annotation).
- FR-1.8d: Every user-workflow platform call must reference the exact platform,
  tooling, and component it invokes, making the step-to-tooling mapping explicit.
- FR-1.8e: The architecture JSON must use top-level `workflow`, `platforms`,
  `layers`, and `connections`. Each platform must contain `componentNodeIds` and
  1-6 important `toolings`; each tooling must identify its owning component.
  Each workflow step must contain 1-2 `platformCalls`, and every call must provide
  explicit `platformId`, `toolingId`, `nodeId`, `action`, `mechanism`, and
  `output` values that resolve to the declared platform, tooling, and component.
- FR-1.8f: Expose and generate only the Validated JSON → GPT-Image-2
  architecture visual. Do not run an intermediate image-to-HTML conversion.
- FR-1.9: Organize the graph into 3-5 readable layers with a clear primary
  left-to-right flow.
- FR-1.10: Produce consistent typography, color, spacing, hierarchy, and component
  styling across the graph.
- FR-1.11: Render the graph as semantic HTML and CSS so layers and components
  remain selectable, inspectable, accessible, and responsive.
- FR-1.12: Support iterative updates to the whole graph or selected components
  without unnecessarily changing approved architecture.
- FR-1.13: Preserve unaffected components and connections when updating an
  existing graph.
- FR-1.14: Flag unsupported factual claims or missing source data instead of
  inventing content.
- FR-1.14a: Ask focused technical questions when material architecture details
  are missing. If the user approves generation without answering, continue only
  by marking inferred components and relationships as explicit assumptions.
- FR-1.14b: Preserve file-path citations for repository-derived components,
  interactions, and slide claims, and distinguish repository evidence from user
  confirmation and assumptions.

#### 4.1.1 Architecture Graph Generation Workflow

- FR-1.15: Convert the approved architecture description into a structured visual
  specification containing components, labels, relationships, groups, hierarchy,
  and data-flow direction.
- FR-1.16: Render the structured specification as a premium HTML/CSS architecture
  canvas with strong visual hierarchy, balanced composition, disciplined spacing,
  consistent styling, and excellent presentation design taste.
- FR-1.17: Let the user review the generated graph and request revisions.
- FR-1.18: Verify that the approved visual accurately represents the agreed
  architecture; generated labels and connections must not silently change the
  approved technical design.
- FR-1.19: Present the graph on a large responsive browser canvas and adapt the
  layout for desktop, tablet, and narrow screens.
- FR-1.20: Render layers, nodes, labels, and interaction summaries as HTML
  elements rather than a flat generated image.
- FR-1.20a: Draw directional relationship lines between semantic component cards,
  visually distinguish request, event, data, and authentication flows, and retain
  an accessible text interaction list.
- FR-1.20b: Display technology badges, confirmed/assumed provenance, trust and
  data boundaries, a relationship legend, and a clearly emphasized primary flow.
- FR-1.21: Store the structured architecture specification so later revisions can
  be made consistently.

#### 4.1.2 Slide Generation Workflow

- FR-1.22: Generate architecture visuals and slides only after the complete outline
  has been explicitly approved once.
- FR-1.23: Generate a coherent deck containing at minimum a title/overview slide,
  Problem Statement slide, User Scenarios slide, Solution slide, and Architecture slide.
- FR-1.24: Use the approved outline and stored architecture specification as the
  source of truth; slide generation must not silently introduce new claims,
  components, or integrations.
- FR-1.25: Convert the generated GPT-Image-2 architecture PNG directly into
  object-level editable PowerPoint content with the image-to-editable-ppt workflow.
  Do not use an intermediate HTML reconstruction or a full-slide screenshot.
- FR-1.25a: Preserve component technologies, relationship details, and assumption
  markers in the generated architecture slide.
- FR-1.26: Render the deck in a presentation-ready 16:9 HTML format with
  consistent typography, spacing, color, hierarchy, and responsive preview.
- FR-1.27: Let the user preview every slide, navigate between slides, and request
  targeted revisions.
- FR-1.28: Store both the structured slide-deck JSON and generated HTML as project
  assets with lineage back to the approved outline and architecture asset.
- FR-1.29: Provide one download action for the object-level editable `.pptx`
  generated directly from the approved architecture image.
- FR-1.30: Preserve approved architecture and unaffected slide content when
  regenerating or revising a selected slide.
- FR-1.31: Generate one editable speaker-note segment for every generated slide.
- FR-1.32: Speaker notes must use exact slide IDs and titles, remain grounded in
  the approved outline and deck, and be stored as a versioned speech-script asset.
- FR-1.33: The initial release generates text speaker notes only; speech synthesis
  and personal-voice audio remain a future capability.

**Inputs:** user brief, optional source files, optional existing architecture
specification, and optional brand theme.

**Outputs:** approved three-part outline, structured architecture
JSON, a GPT-Image-2 architecture PNG, structured slide-deck JSON, and a
downloadable object-level editable `.pptx`, plus editable
slide-grounded speaker notes.

**Candidate implementation:** GitHub Copilot SDK for guided clarification and
structured graph generation; React and TypeScript for the web UI; semantic HTML
and CSS Grid for architecture rendering; schema validation for graph and slide
JSON; server-side HTML generation with output escaping.

### 4.2 Feature 2 — Update and Enhance Recordings

**Description:** Process an existing presentation or screen recording to improve
its content, pacing, and picture quality. The recording supplies both the demo
timeline and the initial narration transcript. The uploaded recording is always
treated as the source; the agent creates a new refined video and never overwrites
the original.

#### 4.2.1 Transcribe and Refine the Content

**Requirements:**
- FR-2.1: Accept an uploaded demo video in a common format such as MP4 or MOV.
- FR-2.1a: Read and inspect the existing video's container, codecs, duration,
  resolution, frame rate, audio tracks, and keyframes before planning edits.
- FR-2.2: Extract the audio track and generate a time-coded transcript.
- FR-2.3: Identify distinct narration segments and associate them with the
  corresponding video time ranges.
- FR-2.4: Refine the transcript for clarity, concision, grammar, narrative flow,
  and consistency with the approved slides without changing the user's intended
  meaning.
- FR-2.5: Preserve important technical terms, product names, numbers, and claims;
  flag uncertain transcription instead of silently guessing.
- FR-2.6: Present the original transcript and proposed refined script in an
  editable form.
- FR-2.7: Require explicit user approval of the revised text before personal-voice
  narration is generated.
- FR-2.8: Preserve both the original transcript and each approved script revision.

#### 4.2.2 Speed Up Hanging or Inactive Parts

**Requirements:**
- FR-2.9: Detect hanging or inactive sections using configurable signals,
  including silence, little or no visual change, frozen frames, and long cursor or
  application inactivity.
- FR-2.10: Distinguish intentional pauses from likely unwanted delays by using
  minimum-duration thresholds and surrounding speech/activity context.
- FR-2.11: Speed up, shorten, or remove detected sections according to user
  preferences.
- FR-2.12: Allow configurable detection thresholds, target speed, and minimum
  retained pause duration.
- FR-2.13: Present detected edit ranges for user review or produce an edit decision
  list before rendering when review mode is enabled.

#### 4.2.3 Improve Video Picture Quality

**Requirements:**
- FR-2.14: Improve perceived clarity through configurable denoising, deblocking,
  sharpening, contrast/color correction, and upscaling where appropriate.
- FR-2.15: Optimize screen recordings for readable text and UI details without
  introducing excessive halos, flicker, or artificial texture.
- FR-2.16: Preserve the original aspect ratio unless the user explicitly requests
  cropping or reframing.
- FR-2.17: Avoid claiming that missing source detail has been recovered; clearly
  describe enhancement as improving perceived quality.
- FR-2.18: Support output-resolution and quality presets, including "preserve
  source", 1080p, and 4K when the source and processing environment permit.
- FR-2.19: Preserve audio/video synchronization across all speed and enhancement
  operations.
- FR-2.20: Preserve the original file and produce a separate enhanced output.
- FR-2.21: Generate a processing summary listing accelerated ranges, filters
  applied, output resolution, duration change, and any quality warnings.
- FR-2.22: Apply approved transcript, pacing, clarity, audio, and timing changes to
  a working timeline and render a new video file from that timeline.
- FR-2.23: Optionally use a generative video model to create or remix approved
  replacement segments or B-roll, while retaining deterministic control of cuts,
  speed changes, synchronization, and output encoding.
- FR-2.24: Clearly identify generated or remixed segments in the processing
  summary and require user approval before inserting them into the final video.

**Inputs:** demo video, approved slide/story context, optional edit preferences,
quality preset, and output resolution.

**Outputs:** time-coded transcript, editable refined script, enhanced `.mp4`,
optional edit decision list, and processing summary.

**Candidate implementation:** `ffmpeg` for detection/trimming/re-muxing;
`pydub`/`librosa` for silence detection; OpenCV for frozen-frame and motion
analysis; Azure AI Speech for time-coded transcription; an LLM for grounded script
refinement; FFmpeg filters or an approved video super-resolution model for
picture enhancement; optional Foundry `sora-2` for approved generative/remix
segments. `sora-2` is not used for deterministic pause acceleration, denoising,
sharpening, or final A/V synchronization.

### 4.3 Feature 3 — Text-to-Your-Own-Voice (Personalized Narration)

**Description:** Convert the user-approved revised script into speech rendered in
the presenter's own voice, then synchronize it with the edited demo video.

**Requirements:**
- FR-3.1: Accept a text script and produce spoken audio.
- FR-3.2: Support a **custom/personal voice** (voice cloning or Azure Custom Neural
  Voice) trained/enrolled from user samples.
- FR-3.3: Support prosody controls (rate, pitch, pauses) via SSML.
- FR-3.4: Output standard audio formats (WAV/MP3).
- FR-3.5: Enforce responsible-AI consent and voice-ownership verification before
  cloning a voice.
- FR-3.6: Allow the user to preview and approve a short sample before generating
  the complete narration.
- FR-3.7: Support pronunciation guidance for names, acronyms, and technical terms.
- FR-3.8: Allow generated narration to be aligned with slide timings or added to
  the enhanced recording from Feature 2.
- FR-3.9: Restrict each voice profile to its verified owner or explicitly
  authorized users and provide a way to delete the profile and associated samples.
- FR-3.10: Accept only the explicitly approved script revision as the source for
  final narration.
- FR-3.11: Generate narration as time-addressable segments so individual sections
  can be regenerated without rerendering the entire voice track.
- FR-3.12: Synchronize narration segments with the corresponding demo actions,
  accounting for video sections that were accelerated, shortened, or removed.
- FR-3.13: When narration is longer than its available video segment, propose a
  speech-rate adjustment, video hold, timeline extension, or script revision
  instead of silently clipping content.
- FR-3.14: Replace, duck, or retain the original recording audio according to the
  user's selected mix strategy.
- FR-3.15: Provide a synchronized preview for user review before final export.
- FR-3.16: Allow the user to revise text, pronunciation, timing, or voice settings
  and regenerate only the affected segments.

**Inputs:** approved script revision, time-coded transcript, edited video timeline,
voice profile ID, optional SSML/prosody settings, and audio-mix preference.

**Outputs:** `.wav` / `.mp3` narration, synchronized preview `.mp4`, and final
export `.mp4`.

**Candidate implementation:** **Azure AI Speech — Custom Neural Voice (CNV)** with
consent workflow; SSML for control. (CNV is a gated/limited-access feature.)

### 4.4 Cross-Cutting Orchestration and Asset Storage

**Description:** Treat the end-to-end workflow as one presentation project whose
outputs are durable, versioned assets that later steps can consume without asking
the user to re-upload or restate approved information.

- FR-4.1: Create a unique project when the user submits the initial idea.
- FR-4.2: Persist the brief, outline drafts and approved outline, architecture JSON,
  slide-deck JSON/HTML, speaker notes, source recording, refined recording, transcript, script revisions,
  voice-asset references, narration segments, previews, and exports under that
  project.
- FR-4.3: Give every asset a stable ID, type, format, creation time, revision, and
  source-asset lineage.
- FR-4.4: Never overwrite source assets. Revisions and refinements must create new
  assets linked to their inputs.
- FR-4.5: Let each workflow step resolve its required inputs from the project
  manifest and reject execution when mandatory approved assets are missing.
- FR-4.6: Store user voice assets separately from presentation content and keep
  only authorized voice-profile references in the project manifest.
- FR-4.7: Support configurable durable storage: filesystem-backed storage for
  local development and managed object/file storage for deployed environments.
- FR-4.8: Preserve project manifests and generated assets across browser refreshes
  and server requests, subject to configured retention and deletion policies.
- FR-4.9: Record processing disclosures, approvals, warnings, and export metadata
  alongside the relevant asset.
- FR-4.10: Expose conversational and structured generation through a versioned
  Foundry Hosted Agent `invocations` contract while preserving the browser-facing
  REST and SSE API.
- FR-4.11: Keep the Hosted Agent stateless with respect to presentation projects;
  the application API must validate approvals, persist assets, and revalidate
  structured model output at the trust boundary.
- FR-4.12: Use managed identity for API-to-Foundry and API-to-storage access.
  Browser clients must never receive Foundry, storage, or GitHub credentials.
- FR-4.13: Use filesystem storage only for local development and managed durable
  object storage for deployed project manifests and assets.
- FR-4.14: Keep uploaded recordings and FFmpeg processing outside the Hosted
  Agent invocation path.
- FR-4.15: Inject the GitHub token into the Hosted Agent through a Foundry secret
  connection or a managed-identity-readable Key Vault reference. The token must
  not appear as a literal in source, deployment manifests, image layers, or logs.
- FR-4.16: When the Hosted Agent uses GitHub Copilot models, configure an explicit
  GPT-family model rather than relying on the SDK default. The initial hosted
  deployment uses `gpt-5.6-sol`.
- FR-4.17: Give each project an authenticated or signed-session owner and
  authorize all project, asset, upload, download, repository, and generation
  operations against that owner.
- FR-4.18: Store repository evidence as a versioned asset containing repository
  identity, commit SHA, selected paths, hashes, bounded redacted snippets,
  derived technical evidence, citations, limits, and warnings.
- FR-4.19: Keep GitHub OAuth tokens, installation tokens, App private keys, and
  client secrets out of browser storage, project assets, prompts, logs, and
  telemetry.

## 5. End-to-End User Workflow

The canonical workflow is:

**Describe idea → Refine outline → Review/edit outline summary → Approve outline →
Generate slides → Generate speaker notes → Upload recording → Refine recording**

The Presentation Agent orchestrates these steps through a shared project manifest
and asset store so every approved output becomes the input to the next step.

1. **Describe idea:** The user describes the idea, audience, purpose, and optional
   source material.
2. **Refine outline:** The agent uses focused Q&A to refine Problem Statement,
   User Scenarios, and Solution without intermediate approvals.
3. **Review/edit outline summary:** The application highlights the structured
   outline in the center; direct edits autosave and chat updates the same model.
4. **Approve outline:** The user approves all three sections once.
5. **Generate slides:** The agent generates the architecture options and stores a presentation-ready HTML
   deck grounded in the approved outline and architecture. The user previews the
   deck and may download HTML or an optional `.pptx`.
6. **Generate speech:** The agent creates editable speaker notes for each slide.
7. **Upload recording:** The user uploads the untouched
   source video into the same presentation project.
8. **Refine recording:** The agent inspects the stored source, accelerates inactive
   ranges, improves perceived clarity, preserves A/V synchronization, and renders
   a separate refined video asset.

## 6. Initial Release Acceptance Criteria

- AC-1: Given an initial brief, the agent conversationally refines Problem Statement,
  User Scenarios, and Solution without section approvals.
- AC-1b: Given only an idea and no codebase, the first outline already contains all
  three fields; the user can then refine them through chat or direct editing.
- AC-1a: Given a repository URL, the first outline contains all three fields
  summarized from bounded repository evidence and clearly marks unproven intent.
- AC-2: Given an approved architecture specification, the agent generates a
  professionally designed HTML/CSS architecture graph and supports revision
  without changing the agreed technical meaning.
- AC-3: Given the single approved outline and optional source material, the
  agent returns validated graph JSON and renders readable layers, components, and
  labeled flows responsively in the browser.
- AC-4: Given an approved outline, the agent generates a presentation-ready HTML
  deck containing Problem Statement, User Scenarios, Solution, and Architecture
  slides, stores its JSON and HTML assets, and supports preview and download.
- AC-5: The user can edit the central outline directly, see it autosave, approve it
  once, and generate slides without re-entering information.
- AC-5a: Given generated slides, the agent creates one editable grounded speaker
  note for every slide and stores it with asset lineage.
- AC-6: Given a recording containing at least one qualifying inactive section,
  the agent identifies and accelerates that section according to the configured
  thresholds without losing A/V synchronization.
- AC-7: Given a low-quality screen recording, the agent exports a separate
  enhanced MP4 in which text/UI readability is improved or a warning explains why
  meaningful improvement is not possible.
- AC-8: Given an uploaded demo recording, the agent produces a time-coded
  transcript and an editable refined script while flagging uncertain passages.
- AC-9: The agent does not generate final personal-voice narration until the user
  explicitly approves a script revision.
- AC-10: Given an approved script and verified voice profile, the agent generates
  intelligible narration in the user's authorized voice and synchronizes it with
  the edited demo timeline.
- AC-11: The user can preview the synchronized result, revise an affected segment,
  and export the final HTML, JSON, MP4, and optional WAV/MP3 assets without altering the
  preserved source files.
- AC-12: Every generated asset has project ownership, revision metadata, and
  source-asset lineage; source files are never overwritten.
