import { describe, it, expect } from 'vitest'
import { sanitize } from '../../src/middlewares/sanitize.js'

const run = async (body, rawBodyFields) => {
  const request = { body, routeOptions: { config: rawBodyFields ? { rawBodyFields } : {} } }
  await sanitize(request)
  return request.body
}

describe('global request sanitizer', () => {
  it('still strips tags and script patterns from ordinary fields', async () => {
    const out = await run({ name: ' <b>Ann</b> ', note: 'hi onclick=bad() javascript:x' })
    expect(out.name).toBe('Ann')
    expect(out.note).not.toMatch(/onclick=|javascript:/i)
  })

  it('leaves a declared rich-text field untouched so the route can sanitize it itself', async () => {
    const html = '<h2>Title</h2><p>Hello <a href="https://x.dev">link</a></p>'
    const out = await run({ title: '<i>T</i>', contentHtml: html }, ['contentHtml'])
    expect(out.contentHtml).toBe(html)
    expect(out.title).toBe('T') // other fields are still cleaned
  })

  it('only exempts the named fields', async () => {
    const out = await run({ contentHtml: '<p>a</p>', excerpt: '<p>b</p>' }, ['contentHtml'])
    expect(out.contentHtml).toBe('<p>a</p>')
    expect(out.excerpt).toBe('b')
  })
})
