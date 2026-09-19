import { success, error } from '../../utils/apiResponse.js'
import { UsersService } from '../users/users.service.js'
import { UsersRepository } from '../users/users.repository.js'
import { query } from '../../config/database.js'
import { HelpFaqsRepository } from '../admin/help-faqs/help-faqs.repository.js'
import { publicFaqsSchema } from '../admin/help-faqs/help-faqs.schema.js'
import { customerAccountDeletionRoutes } from '../admin/account-deletion/account-deletion.routes.js'

export default async function customerRoutes(fastify) {
  const repository = new UsersRepository()
  const service = new UsersService(repository)

  // GET /support-contact — a small whitelisted slice of app_settings (just
  // the support phone/email). Public on purpose: it's the number/address
  // printed on the Help screen, which signed-out visitors can open too. The
  // full app_settings table stays admin-only via GET /api/v1/admin/settings.
  fastify.get('/support-contact', {
    schema: {
      tags: ['Customer Profile'],
      summary: 'Get the customer support phone/email'
    }
  }, async (request, reply) => {
    const { rows } = await query(
      `SELECT key, value FROM app_settings WHERE key IN ('support_phone', 'support_email')`
    )
    const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    return reply.code(200).send(success({
      phone: settings.support_phone || null,
      email: settings.support_email || null,
    }, 'Support contact fetched successfully'))
  })

  // GET /faqs — the admin-managed Help & FAQs list (dashboard → Help & FAQs).
  // Public on purpose: the Help screen is reachable before sign-in and holds
  // nothing but support copy. Only enabled FAQs are returned.
  const faqsRepository = new HelpFaqsRepository()
  fastify.get('/faqs', { schema: publicFaqsSchema }, async (request, reply) => {
    const faqs = await faqsRepository.findAllActive()
    return reply.code(200).send(success(
      faqs.map(({ id, question, answer }) => ({ id, question, answer })),
      'FAQs fetched successfully'
    ))
  })

  // POST/GET /account-deletion — customer "Delete Account" request + status.
  // Approval is an admin decision (dashboard → Deletion Requests).
  fastify.register(customerAccountDeletionRoutes, { prefix: '/account-deletion' })

  // GET /checkout-content — the admin-editable advance-payment / refund copy
  // shown on the payment screen (another small whitelisted slice of
  // app_settings, same idea as /support-contact). A key with no saved value
  // comes back null and the app falls back to its built-in text.
  fastify.get('/checkout-content', {
    preHandler: [fastify.authenticate, fastify.authorize(['CUSTOMER'])],
    schema: {
      tags: ['Customer Profile'],
      summary: 'Get the admin-editable checkout advance/refund messages',
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    const { rows } = await query(
      `SELECT key, value FROM app_settings WHERE key IN (
         'checkout_advance_title', 'checkout_advance_subtitle',
         'checkout_refund_title', 'checkout_refund_body')`
    )
    const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    const text = (v) => (typeof v === 'string' && v.trim() ? v : null)
    return reply.code(200).send(success({
      advanceTitle: text(settings.checkout_advance_title),
      advanceSubtitle: text(settings.checkout_advance_subtitle),
      refundTitle: text(settings.checkout_refund_title),
      refundBody: text(settings.checkout_refund_body),
    }, 'Checkout content fetched successfully'))
  })

  fastify.get('/me', {
    preHandler: [fastify.authenticate, fastify.authorize(['CUSTOMER'])],
    schema: {
      tags: ['Customer Profile'],
      summary: 'Get customer profile',
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    const profile = await service.getProfile(request.user.id)
    if (!profile) {
      return reply.code(404).send(error('Customer profile not found', 'CUSTOMER_NOT_FOUND'))
    }
    return reply.code(200).send(success(profile, 'Customer profile fetched successfully'))
  })

  fastify.patch('/me', {
    preHandler: [fastify.authenticate, fastify.authorize(['CUSTOMER'])],
    schema: {
      tags: ['Customer Profile'],
      summary: 'Update customer profile',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string', format: 'email' },
          photo_url: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { name, email, photo_url } = request.body
    const updateData = {}
    if (name !== undefined) updateData.name = name
    if (email !== undefined) updateData.email = email
    if (photo_url !== undefined) updateData.avatar_url = photo_url

    const result = await service.updateProfile(request.user.id, updateData)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'UPDATE_PROFILE_FAILED'))
    }
    return reply.code(200).send(success(result.user, 'Customer profile updated successfully'))
  })

  fastify.delete('/account', {
    preHandler: [fastify.authenticate, fastify.authorize(['CUSTOMER'])],
    schema: {
      tags: ['Customer Profile'],
      summary: 'Anonymise and soft-delete customer account',
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    await service.repo.deleteUser(request.user.id)
    reply.clearCookie('refreshToken', { path: '/api/v1/auth' })
    return reply.code(200).send(success(null, 'Customer account soft-deleted and anonymised successfully'))
  })
}
