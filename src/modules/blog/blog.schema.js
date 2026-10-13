/**
 * Blog JSON schemas.
 *
 * NB: this Fastify instance runs Ajv with `removeAdditional: 'all'`, so every
 * response field must be listed under `properties` or it is silently dropped.
 * Request bodies list their fields with empty schemas (`{}`) — Ajv then keeps
 * the values untouched (no coercion, and `removeAdditional: 'all'` ignores
 * `additionalProperties: true`), and the service validates them with zod,
 * which gives per-field error messages.
 */

const nullableString = { type: ['string', 'null'] }

const summaryProps = {
  id: { type: 'string' },
  title: { type: 'string' },
  slug: { type: 'string' },
  excerpt: nullableString,
  coverImageUrl: nullableString,
  coverImageAlt: nullableString,
  category: {
    type: ['object', 'null'],
    properties: { name: { type: 'string' }, slug: { type: 'string' } },
  },
  tags: { type: 'array', items: { type: 'string' } },
  authorName: { type: 'string' },
  publishedAt: nullableString,
  readingMinutes: { type: 'integer' },
  viewCount: { type: 'number' },
  isFeatured: { type: 'boolean' },
}

const postProps = {
  ...summaryProps,
  contentHtml: { type: 'string' },
  status: { type: 'string' },
  focusKeyword: nullableString,
  metaTitle: nullableString,
  metaDescription: nullableString,
  canonicalUrl: nullableString,
  ogImageUrl: nullableString,
  noindex: { type: 'boolean' },
  wordCount: { type: 'integer' },
  categoryId: nullableString,
  createdAt: { type: 'string' },
  updatedAt: { type: 'string' },
}

const adminRowProps = {
  ...summaryProps,
  status: { type: 'string' },
  noindex: { type: 'boolean' },
  updatedAt: { type: 'string' },
  wordCount: { type: 'integer' },
  focusKeyword: nullableString,
}

const categoryProps = {
  id: { type: 'string' },
  name: { type: 'string' },
  slug: { type: 'string' },
  description: nullableString,
  sortOrder: { type: 'integer' },
  postCount: { type: 'integer' },
}

const obj = (properties) => ({ type: 'object', properties })
const arr = (properties) => ({ type: 'array', items: obj(properties) })

const envelope = (data, paged = false) => ({
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
    data,
    ...(paged
      ? { page: { type: 'integer' }, total: { type: 'integer' }, totalPages: { type: 'integer' } }
      : {}),
  },
})

const uuidParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
}
const slugParams = {
  type: 'object',
  required: ['slug'],
  properties: { slug: { type: 'string', minLength: 1, maxLength: 140 } },
}
const open = (names) => ({
  type: 'object',
  properties: Object.fromEntries(names.map((n) => [n, {}])),
})
const postBody = open([
  'title', 'slug', 'excerpt', 'contentHtml', 'coverImageUrl', 'coverImageAlt', 'categoryId', 'tags',
  'authorName', 'status', 'publishedAt', 'isFeatured', 'focusKeyword', 'metaTitle', 'metaDescription',
  'canonicalUrl', 'ogImageUrl', 'noindex',
])
const categoryBody = open(['name', 'slug', 'description', 'sortOrder'])

// ----------------------------------------------------------------- public
export const publicListSchema = {
  tags: ['Blog'],
  summary: 'Live blog posts, newest first (paginated, optional category)',
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1, maximum: 9999, default: 1 },
      category: { type: 'string', maxLength: 80 },
    },
  },
  response: { 200: envelope({ type: 'array', items: obj(summaryProps) }, true) },
}
export const publicFeaturedSchema = {
  tags: ['Blog'],
  summary: 'Featured live post (or null)',
  response: { 200: envelope({ type: ['object', 'null'], properties: summaryProps }) },
}
export const publicTrendingSchema = {
  tags: ['Blog'],
  summary: 'Trending posts (most views in the last 14 days)',
  querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 } } },
  response: { 200: envelope({ type: 'array', items: obj(summaryProps) }) },
}
export const publicSearchSchema = {
  tags: ['Blog'],
  summary: 'Search live posts',
  querystring: { type: 'object', properties: { q: { type: 'string', maxLength: 120 } } },
  response: { 200: envelope({ type: 'array', items: obj(summaryProps) }) },
}
export const publicCategoriesSchema = {
  tags: ['Blog'],
  summary: 'Categories with live post counts',
  response: { 200: envelope(arr(categoryProps)) },
}
export const publicCategorySchema = {
  tags: ['Blog'],
  summary: 'One category by slug',
  params: slugParams,
  response: { 200: envelope(obj(categoryProps)) },
}
export const publicPostSchema = {
  tags: ['Blog'],
  summary: 'One live post by slug, with table of contents and related posts',
  params: slugParams,
  response: {
    200: envelope({
      type: 'object',
      properties: {
        ...postProps,
        toc: {
          type: 'array',
          items: obj({ id: { type: 'string' }, text: { type: 'string' }, level: { type: 'integer' } }),
        },
        related: { type: 'array', items: obj(summaryProps) },
      },
    }),
  },
}
export const publicViewSchema = {
  tags: ['Blog'],
  summary: 'Record one view of a live post (feeds Trending)',
  params: slugParams,
  response: { 200: envelope({ type: 'null' }) },
}
export const publicSitemapSchema = {
  tags: ['Blog'],
  summary: 'Slugs and dates for the website sitemap',
  response: {
    200: envelope(obj({
      posts: arr({
        slug: { type: 'string' },
        updatedAt: { type: 'string' },
        publishedAt: { type: 'string' },
        coverImageUrl: nullableString,
      }),
      categories: arr({ slug: { type: 'string' } }),
    })),
  },
}

// ------------------------------------------------------------------ admin
export const adminListSchema = {
  tags: ['Blog'],
  summary: 'All posts incl. drafts [ADMIN]',
  querystring: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['draft', 'published', 'scheduled'] },
      q: { type: 'string', maxLength: 80 },
      categoryId: { type: 'string', format: 'uuid' },
      page: { type: 'integer', minimum: 1, default: 1 },
      pageSize: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    },
  },
  response: { 200: envelope({ type: 'array', items: obj(adminRowProps) }, true) },
}
export const adminStatsSchema = {
  tags: ['Blog'],
  summary: 'Post counts and total views [ADMIN]',
  response: {
    200: envelope(obj({
      published: { type: 'integer' }, scheduled: { type: 'integer' },
      drafts: { type: 'integer' }, views: { type: 'number' },
    })),
  },
}
export const adminGetSchema = {
  tags: ['Blog'], summary: 'One post by id [ADMIN]', params: uuidParams,
  response: { 200: envelope(obj(postProps)) },
}
export const adminCreateSchema = {
  tags: ['Blog'], summary: 'Create post [ADMIN]', body: postBody,
  response: { 201: envelope(obj(postProps)) },
}
export const adminUpdateSchema = {
  tags: ['Blog'], summary: 'Update post [ADMIN]', params: uuidParams, body: postBody,
  response: { 200: envelope(obj(postProps)) },
}
export const adminDeleteSchema = {
  tags: ['Blog'], summary: 'Delete post [ADMIN]', params: uuidParams,
  response: { 200: envelope({ type: 'null' }) },
}
export const adminCategoriesSchema = {
  tags: ['Blog'], summary: 'Categories with post counts [ADMIN]',
  response: { 200: envelope(arr(categoryProps)) },
}
export const adminCategoryCreateSchema = {
  tags: ['Blog'], summary: 'Create category [ADMIN]', body: categoryBody,
  response: { 201: envelope(obj(categoryProps)) },
}
export const adminCategoryUpdateSchema = {
  tags: ['Blog'], summary: 'Update category [ADMIN]', params: uuidParams, body: categoryBody,
  response: { 200: envelope(obj(categoryProps)) },
}
export const adminCategoryDeleteSchema = {
  tags: ['Blog'], summary: 'Delete category [ADMIN]', params: uuidParams,
  response: { 200: envelope({ type: 'null' }) },
}
