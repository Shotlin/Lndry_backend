import sanitizeHtml from 'sanitize-html'

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }

export function decodeEntities(value) {
  return value.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
}

/** Plain text from HTML, block boundaries become spaces. */
export function stripHtml(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|h[1-6]|li|blockquote|tr|div|pre)>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\s+/g, ' ')
    .trim()
}

export function countWords(text) {
  const words = String(text || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)
  return words ? words.length : 0
}

export function readingMinutes(words) {
  return Math.max(1, Math.round(words / 200))
}

export function slugify(value, maxLength = 90) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '')
}

export function makeExcerpt(text, max = 160) {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > 80 ? cut.slice(0, lastSpace) : cut).replace(/[\s,.;:–-]+$/, '')}…`
}

const ALIGN = [/^(left|right|center|justify)$/]

/**
 * Everything the editor can produce, and nothing else. Run on every save so
 * stored HTML is always safe to render on the website with innerHTML.
 */
export function sanitizeBlogHtml(html) {
  const clean = sanitizeHtml(String(html || ''), {
    allowedTags: [
      'p', 'br', 'h2', 'h3', 'h4', 'strong', 'b', 'em', 'i', 'u', 's', 'code', 'pre',
      'blockquote', 'ul', 'ol', 'li', 'a', 'img', 'hr',
      'table', 'thead', 'tbody', 'tr', 'th', 'td', 'colgroup', 'col',
    ],
    allowedAttributes: {
      a: ['href', 'target', 'rel', 'title'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'decoding'],
      th: ['colspan', 'rowspan', 'style'],
      td: ['colspan', 'rowspan', 'style'],
      p: ['style'],
      h2: ['style', 'id'],
      h3: ['style', 'id'],
      h4: ['style', 'id'],
      code: ['class'],
      pre: ['class'],
      ol: ['start'],
      col: ['span'],
    },
    allowedStyles: { '*': { 'text-align': ALIGN } },
    allowedSchemes: ['https', 'http', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['https'] },
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    allowProtocolRelative: false,
    allowedClasses: { code: [/^language-[a-z0-9+#-]+$/i], pre: [/^language-[a-z0-9+#-]+$/i] },
    // An image whose (unsafe) source was removed is meaningless — drop it entirely.
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
    transformTags: {
      a: (tagName, attribs) => {
        const href = attribs.href ?? ''
        const external = /^https?:\/\//i.test(href) && !/^https?:\/\/(www\.)?lndry\.in(\/|$)/i.test(href)
        const next = { ...attribs }
        if (external) {
          next.target = '_blank'
          next.rel = 'noopener noreferrer'
        } else {
          delete next.target
          delete next.rel
        }
        return { tagName, attribs: next }
      },
      img: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, loading: 'lazy', decoding: 'async', alt: attribs.alt ?? '' },
      }),
      b: 'strong',
      i: 'em',
    },
  })

  // The editor leaves an empty paragraph after some blocks; drop empties at the edges.
  const trimmed = clean.replace(/^(\s*<p>\s*<\/p>)+/, '').replace(/(<p>\s*<\/p>\s*)+$/, '')
  return addHeadingIds(trimmed).trim()
}

/** Gives every h2–h4 a stable, unique id so the table of contents and deep links work. */
export function addHeadingIds(html) {
  const used = new Map()
  return html.replace(/<h([2-4])((?:\s[^>]*)?)>([\s\S]*?)<\/h\1>/gi, (_m, level, attrs, inner) => {
    const base = slugify(stripHtml(inner), 60) || 'section'
    const count = used.get(base) ?? 0
    used.set(base, count + 1)
    const id = count === 0 ? base : `${base}-${count + 1}`
    const withoutId = attrs.replace(/\sid="[^"]*"/i, '')
    return `<h${level} id="${id}"${withoutId}>${inner}</h${level}>`
  })
}

/** Table of contents entries from sanitised HTML. */
export function extractToc(html) {
  const items = []
  const re = /<h([2-4])[^>]*\sid="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/gi
  let match
  while ((match = re.exec(html))) {
    const text = stripHtml(match[3])
    if (text) items.push({ id: match[2], text, level: Number(match[1]) })
  }
  return items
}
