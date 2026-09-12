import axios from 'axios'
import { success, error } from '../../utils/apiResponse.js'
import { env } from '../../config/env.js'
import { OlaMapsSettingsRepository } from '../admin/ola-maps-settings/ola-maps-settings.repository.js'

const OLA_MAPS_BASE_URL = 'https://api.olamaps.io'
const olaMapsSettingsRepository = new OlaMapsSettingsRepository()

/**
 * Forward-geocodes a free-text query via Ola Maps and shapes each result
 * into a self-contained suggestion — the full address/coordinates are
 * base64-encoded into `place_id` itself, so "select this suggestion"
 * never needs a second Ola API call (unlike Google Places, Ola's geocode
 * response already includes everything a details lookup would give).
 * Returns null when Ola isn't configured/enabled or the call fails, so
 * callers can fall back to Google/mock.
 */
async function _geocodeViaOla(queryText) {
  const settings = await olaMapsSettingsRepository.getCached()
  if (!settings?.isEnabled || !settings?.apiKey) return null

  try {
    const response = await axios.get(`${OLA_MAPS_BASE_URL}/places/v1/geocode`, {
      params: { address: queryText, api_key: settings.apiKey },
      timeout: 8000,
    })
    const results = response.data.geocodingResults || []
    return results.map((r) => {
      const components = r.address_components || []
      const findComponent = (type) =>
        components.find((c) => (c.types || []).includes(type))?.long_name || null
      const detail = {
        formatted_address: r.formatted_address || null,
        lat: r.geometry?.location?.lat ?? null,
        lng: r.geometry?.location?.lng ?? null,
        postal_code: findComponent('postal_code'),
      }
      return {
        description: r.formatted_address || '',
        // No 'ola:' prefix — a literal ':' in a find-my-way path parameter
        // value breaks route matching (404s), since colons are find-my-way's
        // own parameter-syntax character. base64url's alphabet has no
        // colons, slashes, or anything else path-unsafe, so the id is
        // self-describing without needing a prefix — see the decode-first
        // attempt in /place-details below.
        place_id: Buffer.from(JSON.stringify(detail)).toString('base64url'),
      }
    })
  } catch (err) {
    return null
  }
}

export default async function mapsRoutes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate)

  // GET /maps/ola/reverse-geocode -> lat/lng to address, via Ola Maps.
  // Ola's response carries a landmark field the phone's own OS geocoder
  // never provides, and is far more reliable for Indian addresses than the
  // OS geocoder's inconsistent locality/subLocality fields. Key is never
  // sent to the client — dashboard-configured, read from
  // ola_maps_settings, same pattern as the admin settings module.
  fastify.get('/ola/reverse-geocode', {
    schema: {
      tags: ['Maps'],
      summary: 'Reverse-geocode coordinates via Ola Maps',
      security: [{ bearerAuth: [] }],
      query: {
        type: 'object',
        required: ['lat', 'lng'],
        properties: {
          lat: { type: 'number' },
          lng: { type: 'number' },
        },
      },
    },
  }, async (request, reply) => {
    const { lat, lng } = request.query

    const settings = await olaMapsSettingsRepository.getCached()
    if (!settings?.isEnabled || !settings?.apiKey) {
      return reply.code(400).send(error('Ola Maps is not configured or disabled', 'OLA_MAPS_DISABLED'))
    }

    try {
      const response = await axios.get(`${OLA_MAPS_BASE_URL}/places/v1/reverse-geocode`, {
        params: { latlng: `${lat},${lng}`, api_key: settings.apiKey },
        timeout: 8000,
      })

      const result = (response.data.results || [])[0]
      if (!result) {
        return reply.code(200).send(success(null, 'No address found for these coordinates'))
      }

      const components = result.address_components || []
      const findComponent = (type) =>
        components.find((c) => (c.types || []).includes(type))?.long_name || null

      return reply.code(200).send(success({
        formatted_address: result.formatted_address || null,
        landmark: findComponent('landmark'),
        locality: findComponent('locality') || findComponent('sublocality'),
        city: findComponent('locality') || findComponent('administrative_area_level_2'),
        state: findComponent('administrative_area_level_1'),
        postal_code: findComponent('postal_code'),
      }, 'Reverse geocode successful'))
    } catch (err) {
      request.log.error({ err: err.message }, 'Ola Maps reverse-geocode error')
      return reply.code(502).send(error('Ola Maps reverse-geocode failed', 'OLA_MAPS_ERROR'))
    }
  })

  fastify.get('/place-autocomplete', {
    schema: {
      tags: ['Maps'],
      summary: 'Proxy Google Places Autocomplete',
      security: [{ bearerAuth: [] }],
      query: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string' },
          session_token: { type: 'string' },
          location_bias: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { query: input, session_token, location_bias } = request.query

    // Ola Maps first — Google's key here is a known-broken placeholder in
    // production, and Ola's geocode response already carries everything
    // a suggestion needs (see _geocodeViaOla), so no place-details round
    // trip is needed for Ola-sourced results either.
    const olaSuggestions = await _geocodeViaOla(input)
    if (olaSuggestions !== null) {
      return reply.code(200).send(success(olaSuggestions, 'Autocomplete suggestions fetched'))
    }

    const apiKey = process.env.GOOGLE_MAPS_API_KEY || env.GOOGLE_MAPS_API_KEY

    if (!apiKey) {
      if (env.NODE_ENV === 'production') {
        return reply.code(400).send(error('Google Maps API key is missing', 'CONFIG_ERROR'))
      }
      // Return structured mock fallback
      const mockSuggestions = [
        { description: 'Mock Address 1, Indiranagar, Bengaluru, Karnataka, India', place_id: 'mock_place_1' },
        { description: 'Mock Address 2, Koramangala, Bengaluru, Karnataka, India', place_id: 'mock_place_2' },
        { description: 'Mock Address 3, Whitefield, Bengaluru, Karnataka, India', place_id: 'mock_place_3' }
      ].filter(s => s.description.toLowerCase().includes(input.toLowerCase()))

      return reply.code(200).send(success(mockSuggestions, 'Mock autocomplete suggestions fetched'))
    }

    try {
      const params = {
        input,
        key: apiKey,
        types: 'geocode|establishment'
      }
      if (session_token) params.sessiontoken = session_token
      if (location_bias) {
        params.location = location_bias
        params.radius = 5000 // 5km bias
      }

      const response = await axios.get('https://maps.googleapis.com/maps/api/place/autocomplete/json', { params })
      if (response.data.status !== 'OK' && response.data.status !== 'ZERO_RESULTS') {
        throw new Error(response.data.error_message || `Google Places Autocomplete failed: ${response.data.status}`)
      }

      const suggestions = (response.data.predictions || []).map(p => ({
        description: p.description,
        place_id: p.place_id
      }))

      return reply.code(200).send(success(suggestions, 'Autocomplete suggestions fetched'))
    } catch (err) {
      request.log.error({ err }, 'Google Places Autocomplete error')
      return reply.code(500).send(error('Failed to fetch place suggestions', 'MAPS_ERROR'))
    }
  })

  fastify.get('/place-details/:placeId', {
    schema: {
      tags: ['Maps'],
      summary: 'Proxy Google Place Details',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['placeId'],
        properties: {
          placeId: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { placeId } = request.params

    // Ola-sourced suggestion — the details are already encoded in the id
    // itself (see _geocodeViaOla), no API call needed to resolve it. No
    // distinguishing prefix on the id (see the comment there), so just
    // attempt the decode — a real Google place_id or a 'mock_place_N' id
    // never happens to parse as base64url JSON with a numeric `lat`, so
    // this can't misfire on those.
    try {
      const decoded = JSON.parse(Buffer.from(placeId, 'base64url').toString('utf8'))
      if (decoded && typeof decoded.lat === 'number') {
        return reply.code(200).send(success(decoded, 'Place details fetched'))
      }
    } catch (err) {
      // Not an Ola-encoded id — fall through to Google/mock handling below.
    }

    const apiKey = process.env.GOOGLE_MAPS_API_KEY || env.GOOGLE_MAPS_API_KEY

    if (placeId.startsWith('mock_place_') && env.NODE_ENV === 'production') {
      return reply.code(400).send(error('Mock addresses are disabled in this environment', 'CONFIG_ERROR'))
    }

    if (!apiKey) {
      if (env.NODE_ENV === 'production') {
        return reply.code(400).send(error('Google Maps API key is missing', 'CONFIG_ERROR'))
      }
      // Return structured mock fallback based on placeId
      let mockDetail = {
        formatted_address: 'Mock Address 1, Indiranagar, Bengaluru, Karnataka, India',
        lat: 12.9716,
        lng: 77.5946,
        postal_code: '560038'
      }
      if (placeId === 'mock_place_2') {
        mockDetail = {
          formatted_address: 'Mock Address 2, Koramangala, Bengaluru, Karnataka, India',
          lat: 12.9279,
          lng: 77.6271,
          postal_code: '560034'
        }
      } else if (placeId === 'mock_place_3') {
        mockDetail = {
          formatted_address: 'Mock Address 3, Whitefield, Bengaluru, Karnataka, India',
          lat: 12.9698,
          lng: 77.7500,
          postal_code: '560066'
        }
      }
      return reply.code(200).send(success(mockDetail, 'Mock place details fetched'))
    }

    try {
      const response = await axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
        params: {
          place_id: placeId,
          key: apiKey,
          fields: 'formatted_address,geometry,address_components'
        }
      })

      if (response.data.status !== 'OK') {
        throw new Error(response.data.error_message || `Google Place Details failed: ${response.data.status}`)
      }

      const result = response.data.result
      const addressComponents = result.address_components || []
      const pincodeComponent = addressComponents.find(c => c.types.includes('postal_code'))

      const details = {
        formatted_address: result.formatted_address,
        lat: result.geometry?.location?.lat,
        lng: result.geometry?.location?.lng,
        postal_code: pincodeComponent ? pincodeComponent.long_name : null
      }

      return reply.code(200).send(success(details, 'Place details fetched'))
    } catch (err) {
      request.log.error({ err }, 'Google Place Details error')
      return reply.code(500).send(error('Failed to fetch place details', 'MAPS_ERROR'))
    }
  })
}
