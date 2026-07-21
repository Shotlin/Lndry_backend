import { v4 as uuidv4 } from 'uuid'

export const categories = [
  { id: uuidv4(), name: 'Wash & Fold', slug: 'wash-fold', description: 'Clean, folded everyday laundry', sort_order: 1 },
  { id: uuidv4(), name: 'Wash & Iron', slug: 'wash-iron', description: 'Washed, ironed and hung garments', sort_order: 2 },
  { id: uuidv4(), name: 'Dry Cleaning', slug: 'dry-cleaning', description: 'Specialized chemical care for delicate fabrics', sort_order: 3 },
  { id: uuidv4(), name: 'Ironing', slug: 'ironing', description: 'Professional pressing service', sort_order: 4 },
  { id: uuidv4(), name: 'Shoe Care', slug: 'shoe-care', description: 'Cleaning and restoring shoes', sort_order: 5 },
  { id: uuidv4(), name: 'Blanket Cleaning', slug: 'blanket-cleaning', description: 'Deep cleaning for warm blankets', sort_order: 6 },
  { id: uuidv4(), name: 'Curtain Cleaning', slug: 'curtain-cleaning', description: 'Gentle care for household curtains', sort_order: 7 },
  { id: uuidv4(), name: 'Carpet Cleaning', slug: 'carpet-cleaning', description: 'Deep sanitization and dirt removal for carpets', sort_order: 8 },
]

/**
 * Seed categories into the database
 * @param {import('pg').Pool} pool
 */
export async function seedCategories(pool) {
  console.log('🌱 Seeding categories...')

  for (const cat of categories) {
    await pool.query(
      `INSERT INTO service_categories (id, name, slug, description, sort_order, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (slug) DO NOTHING`,
      [cat.id, cat.name, cat.slug, cat.description, cat.sort_order]
    )
  }

  console.log(`  ✅ ${categories.length} categories seeded`)
  return categories
}
