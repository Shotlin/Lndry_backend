import { AdminOrdersRepository } from './orders.repository.js'
import { AdminOrdersService } from './orders.service.js'
import { AdminOrdersController } from './orders.controller.js'
import {
  listOrdersSchema, statsByStatusSchema, orderDetailSchema,
  updateStatusSchema, assignRiderSchema, bulkAssignSchema,
  manualOrderSchema, invoiceSchema, packingSlipSchema, exportSchema,
  refundOrderSchema, cancelOrderSchema, bulkStatusSchema,
} from './orders.schema.js'

import { requireStepUp } from '../../../middlewares/requireStepUp.js'
import { blockLegacyAdminOrderMutation } from './orders.lifecycle-guard.js'

/**
 * Admin orders routes
 * Prefix: /api/v1/admin/orders
 */
export default async function adminOrdersRoutes(fastify) {
  const repo = new AdminOrdersRepository()
  const service = new AdminOrdersService(repo, fastify)
  const ctrl = new AdminOrdersController(service)
  const adminAuth = [fastify.authenticate, fastify.requireAdmin]
  const highRiskAuth = [fastify.authenticate, fastify.requireAdmin, requireStepUp]
  const blockedAdminWrite = [...adminAuth, blockLegacyAdminOrderMutation]
  const blockedHighRiskWrite = [...highRiskAuth, blockLegacyAdminOrderMutation]

  fastify.get('/', { schema: listOrdersSchema, preHandler: adminAuth }, ctrl.findAll.bind(ctrl))
  fastify.get('/stats-by-status', { schema: statsByStatusSchema, preHandler: adminAuth }, ctrl.getStatsByStatus.bind(ctrl))
  fastify.get('/export', { schema: exportSchema, preHandler: adminAuth }, ctrl.exportCSV.bind(ctrl))
  fastify.post('/manual', { schema: manualOrderSchema, preHandler: blockedAdminWrite }, ctrl.createManualOrder.bind(ctrl))
  fastify.post('/bulk-assign', { schema: bulkAssignSchema, preHandler: blockedAdminWrite }, ctrl.bulkAssign.bind(ctrl))
  fastify.get('/:id', { schema: orderDetailSchema, preHandler: adminAuth }, ctrl.findById.bind(ctrl))
  fastify.put('/:id/status', { schema: updateStatusSchema, preHandler: blockedHighRiskWrite }, ctrl.updateStatus.bind(ctrl))
  fastify.put('/:id/assign-rider', { schema: assignRiderSchema, preHandler: blockedAdminWrite }, ctrl.assignRider.bind(ctrl))
  fastify.get('/:id/invoice', { schema: invoiceSchema, preHandler: adminAuth }, ctrl.getInvoice.bind(ctrl))
  fastify.get('/:id/packing-slip', { schema: packingSlipSchema, preHandler: adminAuth }, ctrl.getPackingSlip.bind(ctrl))
  fastify.post('/:id/refund', { schema: refundOrderSchema, preHandler: blockedHighRiskWrite }, ctrl.refundOrder.bind(ctrl))
  fastify.post('/:id/cancel', { schema: cancelOrderSchema, preHandler: blockedHighRiskWrite }, ctrl.cancelOrder.bind(ctrl))
  fastify.post('/bulk-status', { schema: bulkStatusSchema, preHandler: blockedAdminWrite }, ctrl.bulkUpdateStatus.bind(ctrl))
}
