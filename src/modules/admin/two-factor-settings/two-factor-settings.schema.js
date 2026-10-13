const envelope = (summary) => ({
  tags: ['Admin', '2Factor'],
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

export const getTwoFactorSettingsSchema = envelope('Get 2Factor SMS settings (key is never returned)')

export const testTwoFactorSchema = {
  ...envelope('Test a 2Factor API key (typed, or the saved one)'),
  body: { type: 'object', properties: { apiKey: { type: 'string', maxLength: 200 } } },
}

export const saveTwoFactorSchema = {
  ...envelope('Save 2Factor API key / template / on-off'),
  body: {
    type: 'object',
    properties: {
      apiKey: { type: 'string', maxLength: 200 },
      template: { type: 'string', maxLength: 100 },
      isEnabled: { type: 'boolean' },
    },
  },
}

export const removeTwoFactorSchema = envelope('Remove the saved 2Factor key and switch SMS off')

export const sendTestOtpSchema = {
  ...envelope('Send a real test OTP SMS'),
  body: {
    type: 'object',
    required: ['phone'],
    properties: { phone: { type: 'string', maxLength: 20 } },
  },
}
