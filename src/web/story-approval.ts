import type { StorySection } from './types'

const STORY_SECTIONS: StorySection[] = ['problem', 'userStory', 'architecture']

const SECTION_PATTERNS: Record<StorySection, RegExp> = {
  problem: /\bproblem(?:\s+statement)?\b/i,
  userStory: /\buser\s*story\b/i,
  architecture: /\barchitecture\b/i,
}

export function nextStorySection(approved: StorySection[]): StorySection | null {
  return STORY_SECTIONS.find(section => !approved.includes(section)) ?? null
}

export function isStoryApprovalMessage(
  message: string,
  expectedSection: StorySection,
): boolean {
  const approvalIntent =
    /\b(?:i\s+)?approve(?:d)?\b|\blooks?\s+good\b|\blgtm\b/i.test(message)
  if (!approvalIntent) return false

  const mentionedSection = STORY_SECTIONS.find(section =>
    SECTION_PATTERNS[section].test(message))
  return !mentionedSection || mentionedSection === expectedSection
}

export function storyApprovalsFromMessages(messages: string[]): StorySection[] {
  return messages.reduce<StorySection[]>((approved, message) => {
    const expectedSection = nextStorySection(approved)
    if (
      expectedSection &&
      isStoryApprovalMessage(message, expectedSection)
    ) {
      return [...approved, expectedSection]
    }
    return approved
  }, [])
}
