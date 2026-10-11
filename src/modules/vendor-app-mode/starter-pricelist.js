/**
 * Sample starter price list applied when a new POS shop picks "Use LNDRY starter price list".
 * These are ordinary POS catalogue rows (source 'POS'): the owner edits or deletes them freely.
 * The rates are ROUND SAMPLE NUMBERS, not market prices — the app tells the owner to review them.
 * rates are in paise.
 */
export const STARTER_SERVICES = [
  { key: 'dry', name: 'Dry Cleaning' },
  { key: 'wash', name: 'Wash & Fold' },
  { key: 'steam', name: 'Wash & Steam Iron' },
  { key: 'iron', name: 'Steam Iron' },
]

export const STARTER_CATEGORIES = [
  {
    name: "Men's Wear",
    garments: [
      { name: 'Shirt', rates: { dry: 8000, wash: 3000, steam: 4000, iron: 1500 } },
      { name: 'T-Shirt', rates: { dry: 7000, wash: 2500, steam: 3500, iron: 1200 } },
      { name: 'Trousers', rates: { dry: 9000, wash: 3500, steam: 4500, iron: 1500 } },
      { name: 'Suit (2 pc)', rates: { dry: 35000, iron: 6000 } },
    ],
  },
  {
    name: "Women's Wear",
    garments: [
      { name: 'Saree', rates: { dry: 20000, steam: 8000, iron: 4000 } },
      { name: 'Kurta', rates: { dry: 9000, wash: 3500, steam: 4500, iron: 1500 } },
      { name: 'Dress', rates: { dry: 18000, wash: 5000, steam: 7000, iron: 2500 } },
    ],
  },
  {
    name: 'Household',
    garments: [
      { name: 'Bed Sheet (Single)', rates: { dry: 15000, wash: 5000 } },
      { name: 'Bed Sheet (Double)', rates: { dry: 20000, wash: 7000 } },
      { name: 'Pillow Cover', rates: { dry: 5000, wash: 2000 } },
      { name: 'Towel', rates: { dry: 6000, wash: 2500 } },
      { name: 'Blanket (Single)', rates: { dry: 30000 } },
      { name: 'Curtain', rates: { dry: 25000, wash: 8000 } },
    ],
  },
]
