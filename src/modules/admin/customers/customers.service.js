import { AdminCustomersRepository } from './customers.repository.js'
import { logAdminActivity } from '../../../utils/activityLogger.js'
import ExcelJS from 'exceljs'

const repo = new AdminCustomersRepository()

export class AdminCustomersService {
  async list({ page = 1, limit = 20, search, status, sortBy, sortOrder }) {
    const offset = (page - 1) * limit
    return repo.findAll({ offset, limit, search, status, sortBy, sortOrder })
  }

  async getDetail(id) {
    return repo.findById(id)
  }

  async getOrders(customerId, { page = 1, limit = 20 }) {
    const offset = (page - 1) * limit
    return repo.getCustomerOrders(customerId, { offset, limit })
  }

  async getAddresses(customerId) {
    return repo.getCustomerAddresses(customerId)
  }

  async getLTV() {
    return repo.getLTV()
  }

  async getChurned(days) {
    return repo.getChurned(days)
  }

  async getVIP(minOrders) {
    return repo.getVIP(minOrders)
  }

  async creditWallet(userId, amount, description, adminId, ip) {
    const result = await repo.creditWallet(userId, amount, description)
    logAdminActivity(adminId, 'CREDIT_WALLET', 'user', userId, null, { amount, description }, ip)
    return result
  }

  async toggleBlock(userId, blocked, adminId, ip) {
    const user = await repo.toggleBlock(userId, blocked)
    logAdminActivity(adminId, blocked ? 'BLOCK_USER' : 'UNBLOCK_USER', 'user', userId, null, null, ip)
    return user
  }

  async exportCustomers() {
    const customers = await repo.getAllForExport()
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Customers')
    ws.columns = [
      { header: 'ID', key: 'id', width: 36 },
      { header: 'Name', key: 'name', width: 20 },
      { header: 'Phone', key: 'phone', width: 15 },
      { header: 'Email', key: 'email', width: 25 },
      { header: 'Active', key: 'is_active', width: 8 },
      { header: 'Loyalty Points', key: 'loyalty_points', width: 15 },
      { header: 'Wallet', key: 'wallet_balance', width: 10 },
      { header: 'Orders', key: 'order_count', width: 10 },
      { header: 'Total Spent', key: 'total_spent', width: 12 },
      { header: 'Joined', key: 'created_at', width: 20 },
    ]
    customers.forEach(c => ws.addRow(c))
    const buffer = await wb.csv.writeBuffer()
    return { buffer, filename: `customers-${Date.now()}.csv` }
  }

  async sendPersonalNotification(userId, title, body, fastify) {
    if (!fastify) return false
    fastify.emitNotification(userId, { title, body, type: 'ADMIN_MESSAGE' })
    return true
  }
}
