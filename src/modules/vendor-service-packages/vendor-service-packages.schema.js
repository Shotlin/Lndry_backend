const lineProperties = {
  id: { type: 'string' },
  vendorServiceRateId: { type: 'string' },
  allowance: { type: 'number' },
  ratePaise: { type: 'integer' },
  serviceName: { type: 'string' },
  garmentName: { type: 'string' },
}

const definitionProperties = {
  id: { type: 'string' },
  vendorId: { type: 'string' },
  name: { type: 'string' },
  description: { type: ['string', 'null'] },
  pricePaise: { type: 'integer' },
  validityDays: { type: 'integer' },
  active: { type: 'boolean' },
  createdAt: { type: 'string' },
  updatedAt: { type: 'string' },
  lines: { type: 'array', items: { type: 'object', properties: lineProperties } },
}

const serviceLineProperties = {
  vendorServiceRateId: { type: 'string' },
  garmentName: { type: 'string' },
  serviceName: { type: 'string' },
  allowance: { type: 'number' },
  used: { type: 'number' },
  remaining: { type: 'number' },
}

const redemptionProperties = {
  id: { type: 'string' },
  customerPackageId: { type: 'string' },
  vendorServiceRateId: { type: 'string' },
  quantity: { type: 'number' },
  redeemedDate: { type: 'string' },
  orderId: { type: ['string', 'null'] },
  reason: { type: ['string', 'null'] },
  createdBy: { type: 'string' },
  createdAt: { type: 'string' },
}

const customerPackageProperties = {
  id: { type: 'string' },
  vendorId: { type: 'string' },
  packageId: { type: 'string' },
  packageName: { type: 'string' },
  customerUserId: { type: 'string' },
  purchasedDate: { type: 'string' },
  expiresOn: { type: 'string' },
  contractPricePaise: { type: 'integer' },
  pricePaidPaise: { type: 'integer' },
  paymentMode: { type: 'string' },
  paymentStatus: { type: 'string' },
  status: { type: 'string' },
  createdBy: { type: 'string' },
  createdAt: { type: 'string' },
  updatedAt: { type: 'string' },
  services: { type: 'array', items: { type: 'object', properties: serviceLineProperties } },
  redemptions: { type: 'array', items: { type: 'object', properties: redemptionProperties } },
}

const paymentProperties = {
  id: { type: 'string' },
  customerPackageId: { type: 'string' },
  amountPaise: { type: 'integer' },
  mode: { type: 'string' },
  reference: { type: ['string', 'null'] },
  paymentDate: { type: 'string' },
  reason: { type: ['string', 'null'] },
  createdBy: { type: 'string' },
  createdAt: { type: 'string' },
}

const envelope = (dataSchema) => ({
  type: 'object',
  properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: dataSchema },
})

export const listServicePackagesSchema = {
  tags: ['Vendor Service Packages'],
  summary: "This vendor's service package definitions [VENDOR]",
  querystring: { type: 'object', properties: { includeInactive: { type: 'string' } } },
  response: { 200: envelope({ type: 'array', items: { type: 'object', properties: definitionProperties } }) },
}

export const createServicePackageSchema = {
  tags: ['Vendor Service Packages'],
  summary: 'Create a prepaid service package [VENDOR]',
  body: {
    type: 'object',
    required: ['name', 'pricePaise', 'validityDays', 'lines'],
    properties: {
      name: { type: 'string', maxLength: 160 },
      description: { type: 'string', maxLength: 1200 },
      pricePaise: { type: 'integer', minimum: 0 },
      validityDays: { type: 'integer', minimum: 1, maximum: 3650 },
      active: { type: 'boolean' },
      lines: {
        type: 'array', minItems: 1,
        items: { type: 'object', required: ['vendorServiceRateId', 'allowance'], properties: { vendorServiceRateId: { type: 'string', format: 'uuid' }, allowance: { type: 'number', minimum: 0.01 } } },
      },
    },
  },
  response: { 201: envelope({ type: 'object', properties: definitionProperties }) },
}

export const purchasePackageSchema = {
  tags: ['Vendor Service Packages'],
  summary: 'Sell a service package to a customer [VENDOR]',
  body: {
    type: 'object',
    required: ['packageId', 'customerUserId'],
    properties: {
      packageId: { type: 'string', format: 'uuid' },
      customerUserId: { type: 'string', format: 'uuid' },
      purchasedDate: { type: 'string', format: 'date' },
      paymentMode: { type: 'string', enum: ['PAY_LATER', 'CASH', 'UPI', 'CARD', 'BANK'] },
      pricePaidPaise: { type: 'integer', minimum: 0 },
      reason: { type: 'string', maxLength: 500 },
    },
  },
  response: { 201: envelope({ type: 'object', properties: customerPackageProperties }) },
}

export const addPackagePaymentSchema = {
  tags: ['Vendor Service Packages'],
  summary: 'Collect an additional payment on a customer package [VENDOR]',
  params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
  body: {
    type: 'object',
    required: ['amountPaise', 'mode'],
    properties: {
      amountPaise: { type: 'integer', minimum: 1 },
      mode: { type: 'string', enum: ['CASH', 'UPI', 'CARD', 'BANK'] },
      reference: { type: 'string', maxLength: 120 },
      paymentDate: { type: 'string', format: 'date' },
      reason: { type: 'string', maxLength: 500 },
    },
  },
  response: {
    201: envelope({
      type: 'object',
      properties: { payment: { type: 'object', properties: paymentProperties }, customerPackage: { type: 'object', properties: customerPackageProperties }, outstandingPaise: { type: 'integer' } },
    }),
  },
}

export const redeemPackageSchema = {
  tags: ['Vendor Service Packages'],
  summary: 'Redeem one use from a customer package [VENDOR]',
  params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
  body: {
    type: 'object',
    required: ['vendorServiceRateId', 'quantity'],
    properties: {
      vendorServiceRateId: { type: 'string', format: 'uuid' },
      quantity: { type: 'number', minimum: 0.01 },
      orderId: { type: 'string', format: 'uuid' },
      reason: { type: 'string', maxLength: 500 },
    },
  },
  response: { 200: envelope({ type: 'object', properties: customerPackageProperties }) },
}

export const listCustomerPackagesSchema = {
  tags: ['Vendor Service Packages'],
  summary: "A customer's purchased packages at this vendor [VENDOR]",
  params: { type: 'object', required: ['customerUserId'], properties: { customerUserId: { type: 'string', format: 'uuid' } } },
  response: { 200: envelope({ type: 'array', items: { type: 'object', properties: customerPackageProperties } }) },
}
