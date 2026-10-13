import { query } from '../../config/database.js'

const LIVE = `p.status = 'published' AND p.published_at <= NOW()`

const SUMMARY_COLUMNS = `
  p.id, p.title, p.slug, p.excerpt, p.cover_image_url, p.cover_image_alt, p.tags,
  p.author_name, p.published_at, p.reading_minutes, p.view_count, p.is_featured,
  c.name AS category_name, c.slug AS category_slug
`

const FULL_COLUMNS = `
  ${SUMMARY_COLUMNS},
  p.content_html, p.status, p.focus_keyword, p.meta_title, p.meta_description,
  p.canonical_url, p.og_image_url, p.noindex, p.word_count, p.category_id,
  p.created_at, p.updated_at
`

const FROM = `FROM blog_posts p LEFT JOIN blog_categories c ON c.id = p.category_id`

export function formatSummary(r) {
  return {
    id: r.id,
    title: r.title,
    slug: r.slug,
    excerpt: r.excerpt ?? null,
    coverImageUrl: r.cover_image_url ?? null,
    coverImageAlt: r.cover_image_alt ?? null,
    category: r.category_slug ? { name: r.category_name, slug: r.category_slug } : null,
    tags: r.tags ?? [],
    authorName: r.author_name,
    publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
    readingMinutes: r.reading_minutes ?? 1,
    viewCount: Number(r.view_count ?? 0),
    isFeatured: Boolean(r.is_featured),
  }
}

export function formatPost(r) {
  return {
    ...formatSummary(r),
    contentHtml: r.content_html ?? '',
    status: r.status,
    focusKeyword: r.focus_keyword ?? null,
    metaTitle: r.meta_title ?? null,
    metaDescription: r.meta_description ?? null,
    canonicalUrl: r.canonical_url ?? null,
    ogImageUrl: r.og_image_url ?? null,
    noindex: Boolean(r.noindex),
    wordCount: r.word_count ?? 0,
    categoryId: r.category_id ?? null,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  }
}

function formatCategory(r) {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    description: r.description ?? null,
    sortOrder: r.sort_order ?? 0,
    postCount: Number(r.post_count ?? 0),
  }
}

/** Blog repository — public (live posts only) and admin reads/writes. */
export class BlogRepository {
  // ------------------------------------------------------------- public reads
  async listLive({ page = 1, pageSize = 9, categorySlug } = {}) {
    const params = []
    let where = LIVE
    if (categorySlug) {
      params.push(categorySlug)
      where += ` AND c.slug = $${params.length}`
    }
    const { rows: countRows } = await query(`SELECT COUNT(*)::int AS n ${FROM} WHERE ${where}`, params)
    const { rows } = await query(
      `SELECT ${SUMMARY_COLUMNS} ${FROM} WHERE ${where}
       ORDER BY p.published_at DESC LIMIT ${Number(pageSize)} OFFSET ${(Number(page) - 1) * Number(pageSize)}`,
      params
    )
    return { posts: rows.map(formatSummary), total: countRows[0].n }
  }

  async findFeatured() {
    const { rows } = await query(
      `SELECT ${SUMMARY_COLUMNS} ${FROM} WHERE ${LIVE} AND p.is_featured = true
       ORDER BY p.published_at DESC LIMIT 1`
    )
    return rows[0] ? formatSummary(rows[0]) : null
  }

  async findLiveBySlug(slug) {
    const { rows } = await query(`SELECT ${FULL_COLUMNS} ${FROM} WHERE ${LIVE} AND p.slug = $1`, [slug])
    return rows[0] ? formatPost(rows[0]) : null
  }

  /** Most views in the last N days, ties broken by lifetime views then recency. */
  async trending({ days = 14, limit = 5 } = {}) {
    const { rows } = await query(
      `SELECT ${SUMMARY_COLUMNS}, COALESCE(SUM(d.views), 0) AS recent_views
       ${FROM}
       LEFT JOIN blog_post_daily_views d
         ON d.post_id = p.id AND d.day >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date - $1::int
       WHERE ${LIVE}
       GROUP BY p.id, c.name, c.slug
       ORDER BY recent_views DESC, p.view_count DESC, p.published_at DESC
       LIMIT $2`,
      [Math.max(1, days), Math.max(1, Math.min(20, limit))]
    )
    return rows.map(formatSummary)
  }

  async related(post, limit = 3) {
    const { rows } = await query(
      `SELECT ${SUMMARY_COLUMNS} ${FROM}
       WHERE ${LIVE} AND p.id <> $1
       ORDER BY (p.category_id IS NOT DISTINCT FROM $2::uuid) DESC, p.published_at DESC
       LIMIT $3`,
      [post.id, post.categoryId, limit]
    )
    return rows.map(formatSummary)
  }

  async search(term, limit = 24) {
    const { rows } = await query(
      `SELECT ${SUMMARY_COLUMNS},
         (ts_rank(p.search_vector, websearch_to_tsquery('english', $1))
          + CASE WHEN position(lower($1) in lower(p.title)) > 0 THEN 0.5 ELSE 0 END) AS rank
       ${FROM}
       WHERE ${LIVE}
         AND (p.search_vector @@ websearch_to_tsquery('english', $1)
              OR position(lower($1) in lower(p.title)) > 0
              OR position(lower($1) in lower(p.content_html)) > 0)
       ORDER BY rank DESC, p.published_at DESC
       LIMIT $2`,
      [term, Math.max(1, Math.min(50, limit))]
    )
    return rows.map(formatSummary)
  }

  async categoriesWithCounts() {
    const { rows } = await query(
      `SELECT c.*, COUNT(p.id) FILTER (WHERE ${LIVE})::int AS post_count
       FROM blog_categories c LEFT JOIN blog_posts p ON p.category_id = c.id
       GROUP BY c.id ORDER BY c.sort_order, c.name`
    )
    return rows.map(formatCategory)
  }

  async findCategoryBySlug(slug) {
    const { rows } = await query(`SELECT *, 0 AS post_count FROM blog_categories WHERE slug = $1`, [slug])
    return rows[0] ? formatCategory(rows[0]) : null
  }

  async sitemapEntries() {
    const { rows } = await query(
      `SELECT p.slug, p.updated_at, p.published_at, p.cover_image_url
       FROM blog_posts p WHERE ${LIVE} AND p.noindex = false ORDER BY p.published_at DESC`
    )
    return rows.map((r) => ({
      slug: r.slug,
      updatedAt: new Date(r.updated_at).toISOString(),
      publishedAt: new Date(r.published_at).toISOString(),
      coverImageUrl: r.cover_image_url ?? null,
    }))
  }

  async rssPosts(limit = 30) {
    const { rows } = await query(
      `SELECT ${SUMMARY_COLUMNS} ${FROM} WHERE ${LIVE} ORDER BY p.published_at DESC LIMIT $1`,
      [limit]
    )
    return rows.map(formatSummary)
  }

  /** Counts one view for a live post. Returns false when the slug is not a live post. */
  async recordView(slug) {
    const { rows } = await query(
      `WITH target AS (
         SELECT p.id FROM blog_posts p WHERE ${LIVE} AND p.slug = $1
       ), bump AS (
         INSERT INTO blog_post_daily_views (post_id, day, views)
         SELECT id, (NOW() AT TIME ZONE 'Asia/Kolkata')::date, 1 FROM target
         ON CONFLICT (post_id, day) DO UPDATE SET views = blog_post_daily_views.views + 1
         RETURNING post_id
       )
       UPDATE blog_posts SET view_count = view_count + 1
       WHERE id IN (SELECT post_id FROM bump) RETURNING id`,
      [slug]
    )
    return rows.length > 0
  }

  // -------------------------------------------------------------------- admin
  async listAdmin({ status, q, categoryId, page = 1, pageSize = 20 } = {}) {
    const params = []
    const where = []
    if (status === 'draft') where.push(`p.status = 'draft'`)
    if (status === 'published') where.push(`p.status = 'published' AND p.published_at <= NOW()`)
    if (status === 'scheduled') where.push(`p.status = 'published' AND p.published_at > NOW()`)
    if (categoryId) {
      params.push(categoryId)
      where.push(`p.category_id = $${params.length}`)
    }
    if (q) {
      params.push(q.slice(0, 80))
      where.push(`(position(lower($${params.length}) in lower(p.title)) > 0 OR position(lower($${params.length}) in p.slug) > 0)`)
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const { rows: countRows } = await query(`SELECT COUNT(*)::int AS n ${FROM} ${clause}`, params)
    const { rows } = await query(
      `SELECT ${SUMMARY_COLUMNS}, p.status, p.noindex, p.updated_at, p.word_count, p.focus_keyword
       ${FROM} ${clause}
       ORDER BY p.updated_at DESC LIMIT ${Number(pageSize)} OFFSET ${(Number(page) - 1) * Number(pageSize)}`,
      params
    )
    return {
      posts: rows.map((r) => ({
        ...formatSummary(r),
        status: r.status,
        noindex: Boolean(r.noindex),
        updatedAt: new Date(r.updated_at).toISOString(),
        wordCount: r.word_count ?? 0,
        focusKeyword: r.focus_keyword ?? null,
      })),
      total: countRows[0].n,
    }
  }

  async findById(id) {
    const { rows } = await query(`SELECT ${FULL_COLUMNS} ${FROM} WHERE p.id = $1`, [id])
    return rows[0] ? formatPost(rows[0]) : null
  }

  async stats() {
    const { rows } = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'published' AND published_at <= NOW())::int AS published,
         COUNT(*) FILTER (WHERE status = 'published' AND published_at > NOW())::int AS scheduled,
         COUNT(*) FILTER (WHERE status = 'draft')::int AS drafts,
         COALESCE(SUM(view_count), 0)::bigint AS views
       FROM blog_posts`
    )
    const r = rows[0]
    return { published: r.published, scheduled: r.scheduled, drafts: r.drafts, views: Number(r.views) }
  }

  _postParams(d) {
    return [
      d.title, d.slug, d.excerpt, d.contentHtml, d.coverImageUrl, d.coverImageAlt, d.categoryId,
      d.tags, d.authorName, d.status, d.publishedAt, d.isFeatured, d.focusKeyword, d.metaTitle,
      d.metaDescription, d.canonicalUrl, d.ogImageUrl, d.noindex, d.wordCount, d.readingMinutes,
    ]
  }

  async create(d, userId) {
    const { rows } = await query(
      `INSERT INTO blog_posts (title, slug, excerpt, content_html, cover_image_url, cover_image_alt,
         category_id, tags, author_name, status, published_at, is_featured, focus_keyword, meta_title,
         meta_description, canonical_url, og_image_url, noindex, word_count, reading_minutes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING id`,
      [...this._postParams(d), userId ?? null]
    )
    return this.findById(rows[0].id)
  }

  async update(id, d) {
    const { rows } = await query(
      `UPDATE blog_posts SET title=$1, slug=$2, excerpt=$3, content_html=$4, cover_image_url=$5,
         cover_image_alt=$6, category_id=$7, tags=$8, author_name=$9, status=$10, published_at=$11,
         is_featured=$12, focus_keyword=$13, meta_title=$14, meta_description=$15, canonical_url=$16,
         og_image_url=$17, noindex=$18, word_count=$19, reading_minutes=$20
       WHERE id = $21 RETURNING id`,
      [...this._postParams(d), id]
    )
    return rows[0] ? this.findById(rows[0].id) : null
  }

  async delete(id) {
    const { rows } = await query(`DELETE FROM blog_posts WHERE id = $1 RETURNING slug`, [id])
    return rows[0]?.slug ?? null
  }

  async listCategories() {
    const { rows } = await query(
      `SELECT c.*, COUNT(p.id)::int AS post_count
       FROM blog_categories c LEFT JOIN blog_posts p ON p.category_id = c.id
       GROUP BY c.id ORDER BY c.sort_order, c.name`
    )
    return rows.map(formatCategory)
  }

  async createCategory(d) {
    const { rows } = await query(
      `INSERT INTO blog_categories (name, slug, description, sort_order) VALUES ($1,$2,$3,$4) RETURNING *, 0 AS post_count`,
      [d.name, d.slug, d.description, d.sortOrder ?? 0]
    )
    return formatCategory(rows[0])
  }

  async updateCategory(id, d) {
    const { rows } = await query(
      `UPDATE blog_categories SET name=$1, slug=$2, description=$3, sort_order=$4 WHERE id=$5 RETURNING *, 0 AS post_count`,
      [d.name, d.slug, d.description, d.sortOrder ?? 0, id]
    )
    return rows[0] ? formatCategory(rows[0]) : null
  }

  async deleteCategory(id) {
    const { rowCount } = await query(`DELETE FROM blog_categories WHERE id = $1`, [id])
    return rowCount > 0
  }
}
