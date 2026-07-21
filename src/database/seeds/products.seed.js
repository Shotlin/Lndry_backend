import { v4 as uuidv4 } from 'uuid'

/**
 * Seed garment_rates into the database
 * @param {import('pg').Pool} pool
 * @param {Array} categories - Seeded categories with IDs
 */
export async function seedProducts(pool, categories) {
  console.log('🌱 Seeding garment_types...')

  const catMap = {}
  for (const c of categories) {
    catMap[c.slug] = c.id
  }

  const garment_rates = [
    // Wash & Fold
    { name: 'Shirt', slug: 'shirt-wash-fold', price: 40, unit: 'piece', stock: 1000, category: 'wash-fold', featured: true },
    { name: 'Trouser', slug: 'trouser-wash-fold', price: 50, unit: 'piece', stock: 1000, category: 'wash-fold' },
    { name: 'Saree', slug: 'saree-wash-fold', price: 150, unit: 'piece', stock: 1000, category: 'wash-fold' },
    { name: 'Weight-based Clothes', slug: 'weight-based-wash-fold', price: 80, unit: 'kg', stock: 1000, category: 'wash-fold' },

    // Wash & Iron
    { name: 'Shirt', slug: 'shirt-wash-iron', price: 60, unit: 'piece', stock: 1000, category: 'wash-iron', featured: true },
    { name: 'Trouser', slug: 'trouser-wash-iron', price: 70, unit: 'piece', stock: 1000, category: 'wash-iron' },
    { name: 'Saree', slug: 'saree-wash-iron', price: 200, unit: 'piece', stock: 1000, category: 'wash-iron' },
    { name: 'Weight-based Clothes', slug: 'weight-based-wash-iron', price: 110, unit: 'kg', stock: 1000, category: 'wash-iron' },

    // Dry Cleaning
    { name: 'Shirt', slug: 'shirt-dry-clean', price: 120, unit: 'piece', stock: 1000, category: 'dry-cleaning', featured: true },
    { name: 'Trouser', slug: 'trouser-dry-clean', price: 150, unit: 'piece', stock: 1000, category: 'dry-cleaning' },
    { name: 'Saree', slug: 'saree-dry-clean', price: 400, unit: 'piece', stock: 1000, category: 'dry-cleaning' },

    // Ironing
    { name: 'Shirt Press', slug: 'shirt-ironing', price: 15, unit: 'piece', stock: 1000, category: 'ironing' },
    { name: 'Trouser Press', slug: 'trouser-ironing', price: 20, unit: 'piece', stock: 1000, category: 'ironing' },

    // Shoe Care
    { name: 'Leather Shoes', slug: 'leather-shoes-care', price: 300, unit: 'pair', stock: 1000, category: 'shoe-care' },
    { name: 'Sneakers', slug: 'sneakers-care', price: 250, unit: 'pair', stock: 1000, category: 'shoe-care' },

    // Blanket Cleaning
    { name: 'Single Blanket', slug: 'single-blanket-clean', price: 250, unit: 'piece', stock: 1000, category: 'blanket-cleaning' },
    { name: 'Double Blanket', slug: 'double-blanket-clean', price: 350, unit: 'piece', stock: 1000, category: 'blanket-cleaning' },

    // Curtain Cleaning
    { name: 'Normal Curtain', slug: 'curtain-clean', price: 120, unit: 'piece', stock: 1000, category: 'curtain-cleaning' },

    // Carpet Cleaning
    { name: 'Small Carpet', slug: 'small-carpet-clean', price: 400, unit: 'piece', stock: 1000, category: 'carpet-cleaning' },
  ]

  let count = 0
  for (const p of garment_rates) {
    const categoryId = catMap[p.category]
    if (!categoryId) continue

    await pool.query(
      `INSERT INTO garment_types (id, name, slug, unit, stock_quantity, category_id, is_featured, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       ON CONFLICT (slug) DO NOTHING`,
      [uuidv4(), p.name, p.slug, p.unit, p.stock, categoryId, p.featured || false]
    )
    count++
  }

  console.log(`  ✅ ${count} garment_types seeded`)
}
