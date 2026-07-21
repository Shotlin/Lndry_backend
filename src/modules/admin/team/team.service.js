import { TeamRepository } from './team.repository.js'
import { logAdminActivity } from '../../../utils/activityLogger.js'
import bcrypt from 'bcrypt'

const repo = new TeamRepository()

export class TeamService {
    /* ── Roles ── */

    async listRoles() {
        return repo.findAllRoles()
    }

    async getRole(id) {
        return repo.findRoleById(id)
    }

    async createRole(data, adminId, ip) {
        const role = await repo.createRole(data)
        logAdminActivity(adminId, 'CREATE_ROLE', 'role', role.id, null, { name: data.name }, ip)
        return role
    }

    async updateRole(id, data, adminId, ip) {
        const role = await repo.updateRole(id, data)
        if (role) {
            logAdminActivity(adminId, 'UPDATE_ROLE', 'role', id, null, { name: data.name }, ip)
        }
        return role
    }

    async deleteRole(id, adminId, ip) {
        const ok = await repo.deleteRole(id)
        if (ok) {
            logAdminActivity(adminId, 'DELETE_ROLE', 'role', id, null, null, ip)
        }
        return ok
    }

    /* ── Team Members ── */

    async listMembers() {
        return repo.findAllMembers()
    }

    async inviteMember(data, adminId, ip) {
        // Check duplicate email
        const existing = await repo.findByEmail(data.email)
        if (existing) {
            const err = new Error('A user with this email already exists')
            err.statusCode = 409
            throw err
        }

        const passwordHash = await bcrypt.hash(data.password, 12)
        const user = await repo.inviteMember({
            name: data.name,
            email: data.email,
            phone: data.phone,
            roleId: data.role_id,
            passwordHash,
        })

        // Fetch full member record with role info
        const member = await repo.findMemberById(user.id)
        logAdminActivity(adminId, 'INVITE_MEMBER', 'user', user.id, null, { email: data.email }, ip)
        return member
    }

    async updateMember(id, data, adminId, ip) {
        const member = await repo.updateMember(id, {
            roleId: data.role_id,
            isActive: data.is_active,
        })
        if (member) {
            logAdminActivity(adminId, 'UPDATE_MEMBER', 'user', id, null, data, ip)
        }
        return member
    }

    async removeMember(id, adminId, ip) {
        const ok = await repo.removeMember(id)
        if (ok) {
            logAdminActivity(adminId, 'REMOVE_MEMBER', 'user', id, null, null, ip)
        }
        return ok
    }
}
