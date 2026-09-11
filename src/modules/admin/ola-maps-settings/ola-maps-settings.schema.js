const settingsProperties = {
  configured:       { type: 'boolean' },
  isEnabled:        { type: 'boolean' },
  maskedKey:        { type: ['string', 'null'] },
  lastTestedAt:     { type: ['string', 'null'] },
  lastTestStatus:   { type: ['string', 'null'] },
  lastTestMessage:  { type: ['string', 'null'] },
  updatedAt:        { type: ['string', 'null'] },
}

const testResultProperties = {
  success:    { type: 'boolean' },
  statusCode: { type: ['integer', 'null'] },
  message:    { type: 'string' },
}

export const getOlaMapsSettingsSchema = {
  tags: ['Admin', 'Ola Maps'],
  summary: 'Get current Ola Maps integration settings',
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'object', properties: settingsProperties },
      },
    },
  },
}

export const testOlaMapsSettingsSchema = {
  tags: ['Admin', 'Ola Maps'],
  summary: 'Test an Ola Maps API key against the live Ola Maps API',
  body: {
    type: 'object',
    required: ['apiKey'],
    properties: { apiKey: { type: 'string', minLength: 1 } },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'object', properties: testResultProperties },
      },
    },
  },
}

export const saveOlaMapsSettingsSchema = {
  tags: ['Admin', 'Ola Maps'],
  summary: 'Save the Ola Maps API key / enabled flag (re-tests on key change)',
  body: {
    type: 'object',
    properties: {
      apiKey: { type: 'string' },
      isEnabled: { type: 'boolean' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            settings: { type: 'object', properties: settingsProperties },
            testResult: { type: 'object', properties: testResultProperties },
          },
        },
      },
    },
  },
}
