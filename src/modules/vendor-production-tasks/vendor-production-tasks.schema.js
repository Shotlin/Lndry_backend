const taskProperties = {
  id: { type: 'string' },
  vendorId: { type: 'string' },
  garmentUnitId: { type: 'string' },
  orderId: { type: 'string' },
  station: { type: 'string' },
  kind: { type: 'string' },
  status: { type: 'string' },
  priority: { type: 'string' },
  assignedTo: { type: ['string', 'null'] },
  reason: { type: ['string', 'null'] },
  completionNote: { type: ['string', 'null'] },
  outputState: { type: ['string', 'null'] },
  startedAt: { type: ['string', 'null'] },
  startedBy: { type: ['string', 'null'] },
  completedAt: { type: ['string', 'null'] },
  completedBy: { type: ['string', 'null'] },
  createdAt: { type: 'string' },
  updatedAt: { type: 'string' },
}

const envelope = (dataSchema) => ({
  type: 'object',
  properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: dataSchema },
})

export const listProductionTasksSchema = {
  tags: ['Vendor Production Tasks'],
  summary: 'List floor work tasks [VENDOR]',
  querystring: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED', 'CANCELLED'] },
      station: { type: 'string' }, page: { type: 'integer' }, limit: { type: 'integer' },
    },
  },
  response: { 200: envelope({ type: 'array', items: { type: 'object', properties: taskProperties } }) },
}

export const assignProductionTaskSchema = {
  tags: ['Vendor Production Tasks'],
  summary: 'Assign a production task to a staff member [VENDOR]',
  params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
  body: { type: 'object', required: ['employeeId'], properties: { employeeId: { type: 'string', format: 'uuid' } } },
  response: { 200: envelope({ type: 'object', properties: taskProperties }) },
}

export const startProductionTaskSchema = {
  tags: ['Vendor Production Tasks'],
  summary: 'Start an open production task [VENDOR]',
  params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
  response: { 200: envelope({ type: 'object', properties: taskProperties }) },
}
