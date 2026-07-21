import { describe, it, expect } from 'vitest'
import { sanitize } from '../../../src/middlewares/sanitize.js'

describe('sanitize (preHandler hook)', () => {
  it('strips HTML tags, javascript: URIs, and inline event handlers from string fields', async () => {
    const request = {
      body: {
        note: '  <script>alert(1)</script>hello  ',
        link: 'javascript:alert(1)',
        attr: 'onerror=alert(1)',
        nested: { note: 'see onerror=alert(2) below' },
        list: ['<b>bold</b>', 'plain'],
      },
    }

    await sanitize(request)

    expect(request.body.note).toBe('alert(1)hello')
    expect(request.body.link).toBe('alert(1)')
    expect(request.body.attr).toBe('alert(1)')
    expect(request.body.nested.note).toBe('see alert(2) below')
    expect(request.body.list).toEqual(['bold', 'plain'])
  })

  it('does not throw on a request with no body (e.g. a GET request)', async () => {
    const request = {}
    await expect(sanitize(request)).resolves.toBeUndefined()
    expect(request.body).toBeUndefined()
  })

  it('leaves non-string values (numbers, booleans, null) untouched', async () => {
    const request = { body: { count: 3, active: true, meta: null } }

    await sanitize(request)

    expect(request.body).toEqual({ count: 3, active: true, meta: null })
  })
})
