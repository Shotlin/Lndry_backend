const releaseProperties = {
  id:               { type: 'string' },
  app:              { type: 'string' },
  versionName:      { type: 'string' },
  versionCode:      { type: 'integer' },
  releaseNotes:     { type: ['string', 'null'] },
  fileName:         { type: 'string' },
  originalFileName: { type: 'string' },
  fileSizeBytes:    { type: 'integer' },
  sha256:           { type: 'string' },
  isActive:         { type: 'boolean' },
  uploadedBy:       { type: ['string', 'null'] },
  createdAt:        { type: 'string' },
}

const publicReleaseProperties = {
  app:            { type: 'string' },
  appName:        { type: 'string' },
  versionName:    { type: 'string' },
  versionCode:    { type: 'integer' },
  releaseNotes:   { type: ['string', 'null'] },
  fileSizeBytes:  { type: 'integer' },
  downloadUrl:    { type: 'string' },
  updatedAt:      { type: 'string' },
}

export const listAppReleasesSchema = {
  tags: ['App Releases'],
  summary: 'All releases for an app, newest first [ADMIN]',
  querystring: {
    type: 'object',
    required: ['app'],
    properties: { app: { type: 'string', enum: ['CUSTOMER', 'VENDOR'] } },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'array', items: { type: 'object', properties: releaseProperties } },
      },
    },
  },
}

export const uploadAppReleaseSchema = {
  tags: ['App Releases'],
  summary: 'Upload a new APK and roll it out as the active build [ADMIN]',
  response: {
    201: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'object', properties: releaseProperties },
      },
    },
  },
}

export const deleteAppReleaseSchema = {
  tags: ['App Releases'],
  summary: 'Delete a historical (non-active) release [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'null' },
      },
    },
  },
}

export const publicLatestAppReleaseSchema = {
  tags: ['App Releases'],
  summary: 'Latest active release for one app (public)',
  querystring: {
    type: 'object',
    required: ['app'],
    properties: { app: { type: 'string', enum: ['CUSTOMER', 'VENDOR', 'customer', 'vendor'] } },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'object', properties: publicReleaseProperties },
      },
    },
  },
}

export const publicAllAppReleasesSchema = {
  tags: ['App Releases'],
  summary: 'Latest active release for both apps at once (public — the website download section uses this)',
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            customer: { anyOf: [{ type: 'object', properties: publicReleaseProperties }, { type: 'null' }] },
            vendor: { anyOf: [{ type: 'object', properties: publicReleaseProperties }, { type: 'null' }] },
          },
        },
      },
    },
  },
}
