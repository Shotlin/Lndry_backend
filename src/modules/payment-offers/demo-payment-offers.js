const DEMO_PAYMENT_OFFERS = [
  {
    id: '0c3ab950-b432-4ee8-9d8a-0d9604e36c90',
    title: 'Get ₹125 instant cashback',
    description: 'Use HDFC Bank credit cards on Razorpay for bigger laundry bookings.',
    provider: 'HDFC Bank',
    icon_url: null,
    cashback_amount: 125,
    cashback_percent: null,
    min_order_amount: 799,
    max_cashback: 125,
    lock_threshold: 799,
    is_active: true,
    valid_from: '2026-01-01T00:00:00.000Z',
    valid_until: '2027-12-31T23:59:59.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'ae73bca7-4df2-4db8-ae5f-0847d4f7f901',
    title: '10% cashback up to ₹150',
    description: 'Pay with ICICI Bank cards for a stronger checkout value.',
    provider: 'ICICI Bank',
    icon_url: null,
    cashback_amount: 150,
    cashback_percent: 10,
    min_order_amount: 999,
    max_cashback: 150,
    lock_threshold: 999,
    is_active: true,
    valid_from: '2026-01-01T00:00:00.000Z',
    valid_until: '2027-12-31T23:59:59.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: '6273bc62-9241-45bd-b7d3-6e272e5ad5f4',
    title: 'Flat ₹60 Paytm cashback',
    description: 'Choose Paytm Wallet or Paytm UPI and keep more in your pocket.',
    provider: 'Paytm',
    icon_url: null,
    cashback_amount: 60,
    cashback_percent: null,
    min_order_amount: 499,
    max_cashback: 60,
    lock_threshold: 499,
    is_active: true,
    valid_from: '2026-01-01T00:00:00.000Z',
    valid_until: '2027-12-31T23:59:59.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'ad1a8c7e-6f88-46b7-98aa-c632469fbf4f',
    title: '₹40 cashback on any UPI app',
    description: 'Complete checkout on UPI and unlock an easy everyday reward.',
    provider: 'UPI',
    icon_url: null,
    cashback_amount: 40,
    cashback_percent: null,
    min_order_amount: 299,
    max_cashback: 40,
    lock_threshold: 299,
    is_active: true,
    valid_from: '2026-01-01T00:00:00.000Z',
    valid_until: '2027-12-31T23:59:59.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
]

export function getDemoPaymentOffers() {
  return DEMO_PAYMENT_OFFERS.map((offer) => ({ ...offer }))
}

export function mergeDemoPaymentOffers(offers, minimumCount = 4) {
  const merged = [...offers]
  const keys = new Set(
    offers.map((offer) =>
      `${String(offer.provider || '').trim().toUpperCase()}::${String(offer.title || '')
        .trim()
        .toUpperCase()}`
    )
  )

  for (const offer of getDemoPaymentOffers()) {
    if (merged.length >= minimumCount) {
      break
    }

    const key = `${offer.provider.toUpperCase()}::${offer.title.toUpperCase()}`
    if (keys.has(key)) {
      continue
    }

    merged.push(offer)
    keys.add(key)
  }

  return merged
}
