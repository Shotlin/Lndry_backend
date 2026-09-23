import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  isPlausibleGoogleMapsUrl,
  validateGoogleBusinessInput,
  setGoogleBusinessForVendor,
} from '../../src/modules/vendors/google-business.js'

describe('isPlausibleGoogleMapsUrl', () => {
  it('accepts real Google Maps / share links', () => {
    expect(isPlausibleGoogleMapsUrl('https://www.google.com/maps/place/Aqua+Blue+Laundry/@12.97,77.59,17z')).toBe(true)
    expect(isPlausibleGoogleMapsUrl('https://maps.app.goo.gl/xyz123')).toBe(true)
    expect(isPlausibleGoogleMapsUrl('https://goo.gl/maps/abc')).toBe(true)
    expect(isPlausibleGoogleMapsUrl('https://share.google/uXsugDYQn5nbjS8lZ')).toBe(true)
    expect(isPlausibleGoogleMapsUrl('https://g.co/kgs/abc')).toBe(true)
  })

  it('rejects non-Google links and garbage', () => {
    expect(isPlausibleGoogleMapsUrl('https://yelp.com/biz/aqua-blue')).toBe(false)
    expect(isPlausibleGoogleMapsUrl('not a url')).toBe(false)
    expect(isPlausibleGoogleMapsUrl('ftp://google.com/maps')).toBe(false)
  })
})

describe('validateGoogleBusinessInput', () => {
  it('clears everything when the url is blank', () => {
    expect(validateGoogleBusinessInput({ url: '', rating: 4.5, reviewCount: 10, businessName: 'X' }))
      .toEqual({ url: null, rating: null, reviewCount: null, businessName: null })
    expect(validateGoogleBusinessInput({ url: '   ' }))
      .toEqual({ url: null, rating: null, reviewCount: null, businessName: null })
  })

  it('rejects a non-Google link', () => {
    expect(() => validateGoogleBusinessInput({ url: 'https://yelp.com/biz/x' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_GOOGLE_URL', statusCode: 400 }))
  })

  it('accepts a real link with rating and review count, rounds rating to one decimal', () => {
    const result = validateGoogleBusinessInput({
      url: 'https://www.google.com/maps/place/Aqua+Blue+Laundry',
      rating: 4.666,
      reviewCount: 326,
      businessName: 'Aqua Blue Laundry',
    })
    expect(result).toEqual({
      url: 'https://www.google.com/maps/place/Aqua+Blue+Laundry',
      rating: 4.7,
      reviewCount: 326,
      businessName: 'Aqua Blue Laundry',
    })
  })

  it('allows a link with no rating/review count yet (saved, not connected)', () => {
    const result = validateGoogleBusinessInput({ url: 'https://maps.app.goo.gl/xyz' })
    expect(result).toEqual({ url: 'https://maps.app.goo.gl/xyz', rating: null, reviewCount: null, businessName: null })
  })

  it('rejects an out-of-range rating', () => {
    const url = 'https://www.google.com/maps/place/X'
    expect(() => validateGoogleBusinessInput({ url, rating: 5.5 }))
      .toThrow(expect.objectContaining({ code: 'INVALID_GOOGLE_RATING' }))
    expect(() => validateGoogleBusinessInput({ url, rating: -1 }))
      .toThrow(expect.objectContaining({ code: 'INVALID_GOOGLE_RATING' }))
    expect(() => validateGoogleBusinessInput({ url, rating: 'not a number' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_GOOGLE_RATING' }))
  })

  it('rejects a negative or non-integer review count', () => {
    const url = 'https://www.google.com/maps/place/X'
    expect(() => validateGoogleBusinessInput({ url, reviewCount: -5 }))
      .toThrow(expect.objectContaining({ code: 'INVALID_GOOGLE_REVIEW_COUNT' }))
    expect(() => validateGoogleBusinessInput({ url, reviewCount: 3.5 }))
      .toThrow(expect.objectContaining({ code: 'INVALID_GOOGLE_REVIEW_COUNT' }))
  })

  it('trims a blank business name to null', () => {
    const result = validateGoogleBusinessInput({ url: 'https://www.google.com/maps/place/X', businessName: '   ' })
    expect(result.businessName).toBeNull()
  })
})

describe('setGoogleBusinessForVendor', () => {
  let repo
  beforeEach(() => {
    repo = { setGoogleBusiness: vi.fn(async (id, fields) => ({ id, ...fields })) }
  })

  it('saves the validated fields and reports cleared:false when a link is set', async () => {
    const result = await setGoogleBusinessForVendor(repo, 'v1', {
      url: 'https://www.google.com/maps/place/Aqua+Blue+Laundry',
      rating: 4.7,
      reviewCount: 326,
      businessName: 'Aqua Blue Laundry',
    })
    expect(repo.setGoogleBusiness).toHaveBeenCalledWith('v1', {
      url: 'https://www.google.com/maps/place/Aqua+Blue+Laundry',
      rating: 4.7,
      reviewCount: 326,
      businessName: 'Aqua Blue Laundry',
    })
    expect(result.cleared).toBe(false)
    expect(result.vendor.rating).toBe(4.7)
  })

  it('reports cleared:true and nulls everything when the url is blank', async () => {
    const result = await setGoogleBusinessForVendor(repo, 'v1', { url: '' })
    expect(repo.setGoogleBusiness).toHaveBeenCalledWith('v1', {
      url: null, rating: null, reviewCount: null, businessName: null,
    })
    expect(result.cleared).toBe(true)
  })

  it('propagates a validation error without touching the repository', async () => {
    await expect(setGoogleBusinessForVendor(repo, 'v1', { url: 'https://yelp.com/biz/x' }))
      .rejects.toMatchObject({ code: 'INVALID_GOOGLE_URL' })
    expect(repo.setGoogleBusiness).not.toHaveBeenCalled()
  })
})
