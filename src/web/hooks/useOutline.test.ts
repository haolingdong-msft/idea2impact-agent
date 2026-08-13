import { describe, expect, it } from 'vitest'
import { parseOutlineResponse } from './useOutline'

describe('parseOutlineResponse', () => {
  it('explains when an old API returns an HTML 404 page', async () => {
    const response = new Response('<!DOCTYPE html><html><body>Not found</body></html>', {
      status: 404,
      headers: { 'Content-Type': 'text/html' },
    })
    await expect(parseOutlineResponse(response, 'Outline generation'))
      .rejects.toThrow('Restart the API service')
  })

  it('parses a valid outline response', async () => {
    const response = new Response(JSON.stringify({
      outline: {
        problemStatement: 'A complete problem statement.',
        userScenarios: 'A complete set of user scenarios.',
        solution: 'A complete proposed solution.',
        status: 'draft',
      },
    }), { status: 200 })
    await expect(parseOutlineResponse(response, 'Outline generation'))
      .resolves.toEqual(expect.objectContaining({
        outline: expect.objectContaining({ status: 'draft' }),
      }))
  })
})
