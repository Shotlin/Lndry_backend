import { v4 as uuidv4 } from 'uuid'

export async function seedVendors(pool) {
  console.log('🌱 Seeding vendors...')

  const vendorId = '11111111-1111-4111-8111-111111111111'
  const demoPhone = '7013352181'

  // 1. Ensure the demo user exists
  let demoUserId
  const userRes = await pool.query('SELECT id FROM users WHERE phone = $1', [demoPhone])
  
  if (userRes.rows.length > 0) {
    demoUserId = userRes.rows[0].id
  } else {
    demoUserId = uuidv4()
    await pool.query(
      `INSERT INTO users (id, phone, name, role, is_active, created_at, updated_at)
       VALUES ($1, $2, 'Demo Vendor Owner', 'CUSTOMER', true, NOW(), NOW())`,
      [demoUserId, demoPhone]
    )
  }

  // 2. Insert Vendor, ensuring created_by is the demo user
  await pool.query(
    `INSERT INTO vendors (
      id, name, slug, branch_code, description, phone, email,
      address_line1, city, state, pincode, lat, lng,
      delivery_radius_km, is_active, is_verified,
      vendor_approved, account_enabled, marketplace_published,
      approved_service_radius_km, status, created_by
    ) VALUES (
      $1, 'LNDRY Prime - Bengaluru Hub', 'lndry-prime-bengaluru', 'BLR-001', 'Premium garment care and eco-friendly dry cleaning.', '9876543200', 'prime@lndry.app',
      '100 Feet Road, Indiranagar', 'Bengaluru', 'Karnataka', '560038', 12.9716, 77.5946,
      25.0, true, true,
      true, true, true,
      25.0, 'APPROVED', $2
    ) ON CONFLICT (id) DO UPDATE SET
      vendor_approved = true,
      account_enabled = true,
      marketplace_published = true,
      approved_service_radius_km = 25.0,
      status = 'APPROVED',
      created_by = EXCLUDED.created_by,
      deleted_at = NULL`,
    [vendorId, demoUserId]
  )

  // 3. Link demo user as VENDOR_OWNER in vendor_employees
  await pool.query(
    `INSERT INTO vendor_employees (vendor_id, user_id, role, is_active)
     VALUES ($1, $2, 'VENDOR_OWNER', true)
     ON CONFLICT (vendor_id, user_id) DO UPDATE SET 
       role = 'VENDOR_OWNER', 
       is_active = true`,
    [vendorId, demoUserId]
  )

  // Fetch all garment_types
  const gtRes = await pool.query(`SELECT id, name, category_id FROM garment_types WHERE is_active = true`)
  
  let servicesCount = 0
  for (const gt of gtRes.rows) {
    const serviceId = uuidv4()
    const price = gt.name.includes('Blanket') ? 350.00 :
                  gt.name.includes('Carpet') ? 450.00 :
                  gt.name.includes('Curtain') ? 300.00 :
                  gt.name.includes('Dry') ? 250.00 :
                  gt.name.includes('Iron') ? 150.00 : 200.00;

    const vsRes = await pool.query(
      `INSERT INTO vendor_services (id, vendor_id, category_id, garment_rate_id, name, price, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'PUBLISHED')
       ON CONFLICT (vendor_id, category_id) DO UPDATE SET price = EXCLUDED.price, name = EXCLUDED.name, status = 'PUBLISHED'
       RETURNING id`,
      [serviceId, vendorId, gt.category_id, gt.id, gt.name, price]
    )
    const actualServiceId = vsRes.rows[0].id

    await pool.query(
      `INSERT INTO vendor_service_rates (id, vendor_service_id, garment_type_id, rate_paise, is_active)
       VALUES ($1, $2, $3, 4900, true)
       ON CONFLICT (vendor_service_id, garment_type_id) DO UPDATE SET rate_paise = EXCLUDED.rate_paise`,
      [uuidv4(), actualServiceId, gt.id]
    )
    servicesCount++
  }

  // Insert pickup slots for days 0 to 6
  await pool.query(`DELETE FROM vendor_slots WHERE vendor_id = $1`, [vendorId])
  let slotsCount = 0
  for (let day = 0; day <= 6; day++) {
    await pool.query(
      `INSERT INTO vendor_slots (id, vendor_id, day_of_week, start_time, end_time, max_orders, is_active)
       VALUES ($1, $2, $3, '08:00:00', '12:00:00', 50, true)`,
      [uuidv4(), vendorId, day]
    )
    await pool.query(
      `INSERT INTO vendor_slots (id, vendor_id, day_of_week, start_time, end_time, max_orders, is_active)
       VALUES ($1, $2, $3, '14:00:00', '18:00:00', 50, true)`,
      [uuidv4(), vendorId, day]
    )
    slotsCount += 2
  }

  console.log(`  ✅ 1 vendor seeded with ${servicesCount} services and ${slotsCount} slots`)
}
