import { z } from 'zod'
import { notifyWebsiteBlogChanged } from '../../utils/website-revalidate.js'
import {
  countWords, extractToc, makeExcerpt, readingMinutes, sanitizeBlogHtml, stripHtml,
} from './blog.utils.js'

export const BLOG_PAGE_SIZE = 9

const httpsUrl = z.string().trim().max(500).refine((v) => /^https:\/\/\S+$/.test(v), 'Must be an https:// link')
const optionalText = (max) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null))
const optionalUrl = z.union([httpsUrl, z.literal(''), z.null()]).optional().transform((v) => (v ? v : null))
const slug = (max) =>
  z.string().trim().toLowerCase().min(3, 'URL slug is too short').max(max)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single hyphens')

const postSchema = z.object({
  title: z.string().trim().min(3, 'Add a title').max(160),
  slug: slug(120),
  excerpt: optionalText(400),
  contentHtml: z.string().max(400_000).default(''),
  coverImageUrl: optionalUrl,
  coverImageAlt: optionalText(200),
  categoryId: z.string().uuid().nullish().transform((v) => v ?? null),
  tags: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(12).default([])
    .transform((t) => [...new Set(t)]),
  authorName: z.string().trim().min(2).max(80).default('LNDRY Team'),
  status: z.enum(['draft', 'published']),
  publishedAt: z.string().datetime({ offset: true }).nullish().transform((v) => v ?? null),
  isFeatured: z.boolean().default(false),
  focusKeyword: optionalText(80),
  metaTitle: optionalText(120),
  metaDescription: optionalText(320),
  canonicalUrl: optionalUrl,
  ogImageUrl: optionalUrl,
  noindex: z.boolean().default(false),
})

const categorySchema = z.object({
  name: z.string().trim().min(2).max(60),
  slug: slug(80),
  description: optionalText(300),
  sortOrder: z.number().int().min(0).max(1000).default(0),
})

const fail = (code, message, fieldErrors) => ({ success: false, code, message, fieldErrors })
const isUnique = (e) => e?.code === '23505'

/** Turns validated input into the row to store, deriving everything we must not trust from the browser. */
function buildRow(input) {
  const contentHtml = sanitizeBlogHtml(input.contentHtml)
  const text = stripHtml(contentHtml)
  const words = countWords(text)
  const publishing = input.status === 'published'
  return {
    ...input,
    contentHtml,
    excerpt: input.excerpt ?? (text ? makeExcerpt(text, 160) : null),
    publishedAt: publishing ? (input.publishedAt ?? new Date().toISOString()) : input.publishedAt,
    wordCount: words,
    readingMinutes: readingMinutes(words),
  }
}

export class BlogService {
  constructor(repository) {
    this.repo = repository
  }

  // ------------------------------------------------------------------ public
  async publicList({ page = 1, category }) {
    const { posts, total } = await this.repo.listLive({ page, pageSize: BLOG_PAGE_SIZE, categorySlug: category })
    return { posts, total, page, pageSize: BLOG_PAGE_SIZE, totalPages: Math.max(1, Math.ceil(total / BLOG_PAGE_SIZE)) }
  }

  featured() { return this.repo.findFeatured() }
  trending(limit) { return this.repo.trending({ days: 14, limit }) }
  categories() { return this.repo.categoriesWithCounts() }
  sitemap() { return this.repo.sitemapEntries() }
  rss() { return this.repo.rssPosts(30) }

  async publicCategory(slugValue) {
    const category = await this.repo.findCategoryBySlug(slugValue)
    if (!category) return null
    const { total } = await this.repo.listLive({ page: 1, pageSize: 1, categorySlug: slugValue })
    return { ...category, postCount: total }
  }

  async search(term) {
    const q = String(term || '').trim().slice(0, 80)
    if (q.length < 2) return []
    return this.repo.search(q, 24)
  }

  async publicPost(slugValue) {
    const post = await this.repo.findLiveBySlug(slugValue)
    if (!post) return null
    const related = await this.repo.related(post, 3)
    return { ...post, toc: extractToc(post.contentHtml), related }
  }

  recordView(slugValue) { return this.repo.recordView(slugValue) }

  // ------------------------------------------------------------------- admin
  async adminList(filters) {
    const page = Math.max(1, Number(filters.page) || 1)
    const pageSize = Math.min(50, Math.max(1, Number(filters.pageSize) || 20))
    const { posts, total } = await this.repo.listAdmin({ ...filters, page, pageSize })
    return { posts, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) }
  }

  async adminGet(id) {
    const post = await this.repo.findById(id)
    return post ? { success: true, post } : fail('NOT_FOUND', 'Post not found')
  }

  stats() { return this.repo.stats() }

  async createPost(body, ctx) {
    const parsed = postSchema.safeParse(body)
    if (!parsed.success) return fail('VALIDATION_ERROR', 'Please check the highlighted fields.', parsed.error.flatten().fieldErrors)
    try {
      const post = await this.repo.create(buildRow(parsed.data), ctx?.userId)
      notifyWebsiteBlogChanged([post.slug])
      return { success: true, post }
    } catch (e) {
      if (isUnique(e)) return fail('SLUG_TAKEN', 'That URL is already used by another post.', { slug: ['Already in use'] })
      throw e
    }
  }

  async updatePost(id, body) {
    const parsed = postSchema.safeParse(body)
    if (!parsed.success) return fail('VALIDATION_ERROR', 'Please check the highlighted fields.', parsed.error.flatten().fieldErrors)
    const previous = await this.repo.findById(id)
    if (!previous) return fail('NOT_FOUND', 'Post not found')
    try {
      const post = await this.repo.update(id, buildRow(parsed.data))
      if (!post) return fail('NOT_FOUND', 'Post not found')
      notifyWebsiteBlogChanged([previous.slug, post.slug])
      return { success: true, post }
    } catch (e) {
      if (isUnique(e)) return fail('SLUG_TAKEN', 'That URL is already used by another post.', { slug: ['Already in use'] })
      throw e
    }
  }

  async deletePost(id) {
    const slugValue = await this.repo.delete(id)
    if (!slugValue) return fail('NOT_FOUND', 'Post not found')
    notifyWebsiteBlogChanged([slugValue])
    return { success: true }
  }

  adminCategories() { return this.repo.listCategories() }

  async createCategory(body) {
    const parsed = categorySchema.safeParse(body)
    if (!parsed.success) return fail('VALIDATION_ERROR', 'Please check the category.', parsed.error.flatten().fieldErrors)
    try {
      const category = await this.repo.createCategory(parsed.data)
      notifyWebsiteBlogChanged()
      return { success: true, category }
    } catch (e) {
      if (isUnique(e)) return fail('SLUG_TAKEN', 'A category with that URL already exists.', { slug: ['Already in use'] })
      throw e
    }
  }

  async updateCategory(id, body) {
    const parsed = categorySchema.safeParse(body)
    if (!parsed.success) return fail('VALIDATION_ERROR', 'Please check the category.', parsed.error.flatten().fieldErrors)
    try {
      const category = await this.repo.updateCategory(id, parsed.data)
      if (!category) return fail('NOT_FOUND', 'Category not found')
      notifyWebsiteBlogChanged()
      return { success: true, category }
    } catch (e) {
      if (isUnique(e)) return fail('SLUG_TAKEN', 'A category with that URL already exists.', { slug: ['Already in use'] })
      throw e
    }
  }

  async deleteCategory(id) {
    // Posts keep existing (category becomes "none") — the foreign key is ON DELETE SET NULL.
    const ok = await this.repo.deleteCategory(id)
    if (!ok) return fail('NOT_FOUND', 'Category not found')
    notifyWebsiteBlogChanged()
    return { success: true }
  }
}
