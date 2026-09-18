const markProperties = {
  id: { type: 'string' },
  vendorId: { type: 'string' },
  employeeId: { type: 'string' },
  date: { type: 'string' },
  status: { type: 'string' },
  shift: { type: ['string', 'null'] },
  inTime: { type: ['string', 'null'] },
  outTime: { type: ['string', 'null'] },
  workingHours: { type: ['number', 'null'] },
  note: { type: ['string', 'null'] },
  markedBy: { type: 'string' },
  createdAt: { type: 'string' },
}

const rosterEmployeeProperties = {
  id: { type: 'string' },
  name: { type: 'string' },
  role: { type: 'string' },
  status: { type: 'string' },
  shift: { type: ['string', 'null'] },
  inTime: { type: ['string', 'null'] },
  outTime: { type: ['string', 'null'] },
  workingHours: { type: ['number', 'null'] },
}

const envelope = (dataSchema) => ({
  type: 'object',
  properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: dataSchema },
})

export const markAttendanceSchema = {
  tags: ['Vendor Attendance'],
  summary: 'Mark an employee\'s daily attendance [VENDOR]',
  body: {
    type: 'object',
    required: ['employeeId', 'date', 'status'],
    properties: {
      employeeId: { type: 'string', format: 'uuid' },
      date: { type: 'string', format: 'date' },
      status: { type: 'string', enum: ['PRESENT', 'ABSENT', 'HALF_DAY', 'ON_LEAVE', 'HOLIDAY'] },
      shift: { type: 'string', maxLength: 40 },
      inTime: { type: 'string', maxLength: 10 },
      outTime: { type: 'string', maxLength: 10 },
      workingHours: { type: 'number', minimum: 0, maximum: 24 },
      note: { type: 'string', maxLength: 500 },
    },
  },
  response: { 200: envelope({ type: 'object', properties: markProperties }), 201: envelope({ type: 'object', properties: markProperties }) },
}

export const attendanceRosterSchema = {
  tags: ['Vendor Attendance'],
  summary: 'Today\'s (or a given date\'s) staff attendance roster [VENDOR]',
  querystring: { type: 'object', properties: { date: { type: 'string', format: 'date' } } },
  response: {
    200: envelope({
      type: 'object',
      properties: {
        date: { type: 'string' },
        activeEmployees: { type: 'integer' },
        marked: { type: 'integer' },
        statusCounts: { type: 'object' },
        roster: { type: 'array', items: { type: 'object', properties: rosterEmployeeProperties } },
      },
    }),
  },
}
