import { describe, expect, it } from 'vitest'
import {
  addHeadingIds, countWords, extractToc, makeExcerpt, sanitizeBlogHtml, slugify, stripHtml,
} from '../../src/modules/blog/blog.utils.js'

describe('blog sanitizer', () => {
  it('removes scripts, iframes, event handlers and unsafe URLs', () => {
    const html = sanitizeBlogHtml(
      '<p onclick="x()">Hi<script>alert(1)</script></p><iframe src="https://e.com"></iframe>' +
        '<a href="javascript:alert(1)">bad</a><img src="data:image/png;base64,AA"><svg onload="x()"></svg>'
    )
    expect(html).not.toMatch(/script|onclick|iframe|javascript:|data:|svg|onload/)
    expect(html).toContain('<a>bad</a>')
  })

  it('keeps editor formatting and adds unique heading ids', () => {
    const html = sanitizeBlogHtml('<h2>Care steps</h2><p><strong>x</strong></p><h2>Care steps</h2><ul><li><p>a</p></li></ul>')
    expect(html).toContain('<h2 id="care-steps">')
    expect(html).toContain('<h2 id="care-steps-2">')
    expect(html).toContain('<strong>x</strong>')
    expect(extractToc(html).map((t) => t.id)).toEqual(['care-steps', 'care-steps-2'])
  })

  it('treats lndry.in links as internal and external links as safe new-tab links', () => {
    const html = sanitizeBlogHtml('<a href="https://lndry.in/pricing" target="_blank">a</a><a href="https://other.com">b</a>')
    expect(html).toContain('<a href="https://lndry.in/pricing">a</a>')
    expect(html).toContain('target="_blank" rel="noopener noreferrer"')
  })

  it('only allows https images and drops images that lost their source', () => {
    expect(sanitizeBlogHtml('<img src="http://x.com/a.png">')).toBe('')
    expect(sanitizeBlogHtml('<img src="https://x.com/a.png" onerror="x()">')).toContain('loading="lazy"')
  })

  it('drops empty paragraphs at the edges and keeps only text-align styles', () => {
    expect(sanitizeBlogHtml('<p></p><p style="color:red;text-align:center">x</p><p></p>')).toBe('<p style="text-align:center">x</p>')
  })
})

describe('blog text helpers', () => {
  it('slugifies, counts words, strips html and builds excerpts', () => {
    expect(slugify('Wash & Iron: Pune!')).toBe('wash-and-iron-pune')
    expect(countWords(stripHtml('<p>One two</p><p>three</p>'))).toBe(3)
    expect(addHeadingIds('<h3>Hi</h3>')).toBe('<h3 id="hi">Hi</h3>')
    expect(makeExcerpt('word '.repeat(80), 60).endsWith('…')).toBe(true)
  })
})
