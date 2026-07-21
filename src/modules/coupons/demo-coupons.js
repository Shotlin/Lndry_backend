const DEMO_COUPONS = [
  {
    id: 'demo-coupon-lndry50',
    code: 'LNDRY50',
    description: 'Flat ₹50 off on fresh groceries above ₹499',
    discountType: 'FLAT',
    discountValue: 50,
    minOrderAmount: 499,
    maxDiscount: 50,
    usageLimit: null,
    usedCount: 0,
    perUserLimit: 5,
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: '2027-12-31T23:59:59.000Z',
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    terms:
      'Valid on grocery orders above ₹499.\nCannot be clubbed with store-credit promotions.',
    isDemo: true,
  },
  {
    id: 'demo-coupon-fresh20',
    code: 'FRESH20',
    description: '20% off on larger grocery carts up to ₹150',
    discountType: 'PERCENTAGE',
    discountValue: 20,
    minOrderAmount: 699,
    maxDiscount: 150,
    usageLimit: null,
    usedCount: 0,
    perUserLimit: 5,
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: '2027-12-31T23:59:59.000Z',
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    terms:
      'Max discount ₹150.\nBest for stocked-up baskets with fresh and pantry items.',
    isDemo: true,
  },
  {
    id: 'demo-coupon-pantry99',
    code: 'PANTRY99',
    description: 'Flat ₹99 off when your monthly pantry haul crosses ₹999',
    discountType: 'FLAT',
    discountValue: 99,
    minOrderAmount: 999,
    maxDiscount: 99,
    usageLimit: null,
    usedCount: 0,
    perUserLimit: 5,
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: '2027-12-31T23:59:59.000Z',
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    terms:
      'Applies on a single order above ₹999.\nIdeal for staples, cleaning and home essentials.',
    isDemo: true,
  },
  {
    id: 'demo-coupon-family15',
    code: 'FAMILY15',
    description: '15% off family-size carts up to ₹250',
    discountType: 'PERCENTAGE',
    discountValue: 15,
    minOrderAmount: 1199,
    maxDiscount: 250,
    usageLimit: null,
    usedCount: 0,
    perUserLimit: 5,
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: '2027-12-31T23:59:59.000Z',
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    terms:
      'Max discount ₹250.\nDesigned for weekly stock-up carts above ₹1,199.',
    isDemo: true,
  },
]

export function getDemoCoupons() {
  return DEMO_COUPONS.map((coupon) => ({ ...coupon }))
}

export function findDemoCouponByCode(code) {
  const normalizedCode = String(code || '').trim().toUpperCase()
  const coupon = DEMO_COUPONS.find((item) => item.code === normalizedCode)
  return coupon ? { ...coupon } : null
}

export function mergeDemoCoupons(coupons, minimumCount = 4) {
  const merged = [...coupons]
  const codes = new Set(
    coupons.map((coupon) => String(coupon.code || '').trim().toUpperCase())
  )

  for (const coupon of getDemoCoupons()) {
    if (merged.length >= minimumCount) {
      break
    }
    if (codes.has(coupon.code)) {
      continue
    }
    merged.push(coupon)
    codes.add(coupon.code)
  }

  return merged
}
