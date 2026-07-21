import { AddressesController } from './addresses.controller.js'
import { AddressesService } from './addresses.service.js'
import { AddressesRepository } from './addresses.repository.js'
import {
  listAddressesSchema,
  createAddressSchema,
  updateAddressSchema,
  deleteAddressSchema,
  setDefaultSchema,
  validatePincodeSchema,
  getAddressSchema,
  validateLocationSchema,
} from './addresses.schema.js'

/**
 * Addresses routes plugin
 * Prefix: /api/v1/addresses
 * All routes require authentication
 */
export default async function addressesRoutes(fastify) {
  const repository = new AddressesRepository()
  const service = new AddressesService(repository)
  const controller = new AddressesController(service)

  // All address routes require auth
  fastify.addHook('preHandler', fastify.authenticate)

  // GET / — All addresses
  fastify.get('/', {
    schema: listAddressesSchema,
  }, controller.list.bind(controller))

  // GET /:id — Get address by ID
  fastify.get('/:id', {
    schema: getAddressSchema,
  }, controller.get.bind(controller))

  // POST / — Create address
  fastify.post('/', {
    schema: createAddressSchema,
  }, controller.create.bind(controller))

  // PUT /:id — Update address
  fastify.put('/:id', {
    schema: updateAddressSchema,
  }, controller.update.bind(controller))

  // DELETE /:id — Delete address
  fastify.delete('/:id', {
    schema: deleteAddressSchema,
  }, controller.delete.bind(controller))

  // PUT /:id/default — Set default
  fastify.put('/:id/default', {
    schema: setDefaultSchema,
  }, controller.setDefault.bind(controller))

  // POST /validate-location — Check delivery availability by coordinates
  fastify.post('/validate-location', {
    schema: validateLocationSchema,
  }, controller.validateLocation.bind(controller))

  // POST /validate-pincode — Check delivery availability
  fastify.post('/validate-pincode', {
    schema: validatePincodeSchema,
  }, controller.validatePincode.bind(controller))
}
