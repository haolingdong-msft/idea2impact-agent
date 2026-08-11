import { describe, expect, it } from 'vitest'
import {
  isStoryApprovalMessage,
  nextStorySection,
  storyApprovalsFromMessages,
} from './story-approval'

describe('story approval messages', () => {
  it('advances approvals in the required order', () => {
    expect(nextStorySection([])).toBe('problem')
    expect(nextStorySection(['problem'])).toBe('userStory')
    expect(nextStorySection(['problem', 'userStory'])).toBe('architecture')
    expect(nextStorySection(['problem', 'userStory', 'architecture'])).toBeNull()
  })

  it('accepts typed approval for the current section', () => {
    expect(isStoryApprovalMessage('I approve the problem statement.', 'problem')).toBe(true)
    expect(isStoryApprovalMessage('I approve the user story.', 'userStory')).toBe(true)
    expect(isStoryApprovalMessage('Architecture looks good.', 'architecture')).toBe(true)
    expect(isStoryApprovalMessage('approve', 'userStory')).toBe(true)
  })

  it('does not skip a required approval or mistake revision requests for approval', () => {
    expect(isStoryApprovalMessage('I approve the user story.', 'problem')).toBe(false)
    expect(isStoryApprovalMessage('Please revise the user story.', 'userStory')).toBe(false)
  })

  it('restores all sequential approvals from Copilot conversation history', () => {
    expect(storyApprovalsFromMessages([
      'Here is the idea.',
      'approve',
      'I approve the user story.',
      'Architecture looks good.',
    ])).toEqual(['problem', 'userStory', 'architecture'])
  })
})
