// Response `data` is left open (additionalProperties) — the global Ajv config strips undeclared
// fields, and this payload is nested; the service already controls exactly what it returns.
const envelope = (summary) => ({
  tags: ['Admin', 'Razorpay'],
  summary,
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'object', additionalProperties: true },
      },
    },
  },
})

const modeParam = {
  type: 'object',
  required: ['mode'],
  properties: { mode: { type: 'string', enum: ['TEST', 'LIVE', 'test', 'live'] } },
}

export const getRazorpaySettingsSchema = envelope('Get Razorpay settings (secrets are never returned)')

export const testRazorpaySchema = {
  ...envelope('Test Razorpay credentials live'),
  body: {
    type: 'object',
    required: ['mode'],
    properties: {
      mode: { type: 'string', enum: ['TEST', 'LIVE'] },
      keyId: { type: 'string', maxLength: 80 },
      keySecret: { type: 'string', maxLength: 200 },
    },
  },
}

export const saveRazorpayModeSchema = {
  ...envelope('Save the TEST or LIVE Razorpay keys'),
  params: modeParam,
  body: {
    type: 'object',
    properties: {
      keyId: { type: 'string', maxLength: 80 },
      keySecret: { type: 'string', maxLength: 200 },
      webhookSecret: { type: 'string', maxLength: 200 },
    },
  },
}

export const setRazorpayActiveModeSchema = {
  ...envelope('Switch the active Razorpay mode'),
  body: {
    type: 'object',
    required: ['mode'],
    properties: { mode: { type: 'string', enum: ['TEST', 'LIVE'] } },
  },
}

export const clearRazorpayModeSchema = {
  ...envelope('Remove the saved keys of a non-active mode'),
  params: modeParam,
}
