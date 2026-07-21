import { success, error } from '../../utils/apiResponse.js'
import { env } from '../../config/env.js'
import { query } from '../../config/database.js'
import { signAccessToken, signRefreshToken } from '../../utils/jwt.js'

export class AuthController {
  constructor(service) {
    this.service = service
  }

  /**
   * POST /send-otp
   */
  async sendOtp(request, reply) {
    const { phone, account_type } = request.body

    const result = await this.service.sendOtp(phone, account_type)

    if (result.smsOtp) {
      return reply.code(200).send(success({
        challenge_id: result.challenge_id,
        expires_in: result.expires_in
      }, 'OTP sent to your phone via SMS'))
    }

    return reply.code(200).send(success(result, 'OTP challenge generated successfully'))
  }

  /**
   * POST /verify-otp
   */
  async verifyOtp(request, reply) {
    const { phone, challenge_id, otp, device, role } = request.body

    const result = await this.service.verifyOtp(phone, challenge_id || otp, otp || role, device || role)

    if (!result.success) {
      return reply.code(400).send(error(result.message, 'INVALID_OTP'))
    }

    if (result.requires_shop_selection) {
      return reply.code(200).send(
        success(
          {
            requires_shop_selection: true,
            temp_token: result.temp_token,
            vendors: result.vendors,
            user: result.user,
            roles: result.roles
          },
          'Multiple shop assignments — please select a shop'
        )
      )
    }

    // Set refresh token as httpOnly cookie
    reply.setCookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/v1/auth',
      maxAge: 7 * 24 * 60 * 60, // 7 days
    })

    return reply.code(200).send(
      success(
        {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          roles: result.roles,
          user: result.user,
        },
        result.user.isNewUser ? 'Account created successfully' : 'Login successful'
      )
    )
  }

  /**
   * GET /session
   */
  async session(request, reply) {
    const user = await this.service.repo.findById(request.user.id)
    if (!user) {
      return reply.code(404).send(error('User not found', 'USER_NOT_FOUND'))
    }

    const { rows } = await query(
      `SELECT r.name, COALESCE(r.permissions, '[]'::jsonb) AS permissions
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.id = $1`,
      [user.id]
    )
    const permissions = rows[0]?.permissions || []
    
    const vendorRes = await query(
      `SELECT id, status, name FROM vendors WHERE created_by = $1 ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    )
    const onboardingState = {
      has_application: vendorRes.rows.length > 0,
      application_status: vendorRes.rows[0]?.status || null,
      vendor_id: vendorRes.rows[0]?.id || null,
      vendor_name: vendorRes.rows[0]?.name || null
    }

    return reply.code(200).send(success({
      user: {
        id: user.id,
        phone: user.phone,
        email: user.email,
        name: user.name,
        role: user.role,
        avatar_url: user.avatar_url
      },
      permissions,
      onboarding_state: onboardingState
    }, 'Session profile fetched'))
  }

  /**
   * GET /my-roles
   */
  async myRoles(request, reply) {
    const user = await this.service.repo.findById(request.user.id)
    if (!user) {
      return reply.code(404).send(error('User not found', 'USER_NOT_FOUND'))
    }
    const roles = [user.role]
    const staffRes = await this.service.repo.findActiveShopStaffByUserId(user.id)
    for (const s of staffRes) {
      if (!roles.includes(s.role)) {
        roles.push(s.role)
      }
    }
    return reply.code(200).send(success({ roles }, 'Linked roles fetched'))
  }

  /**
   * POST /select-role
   */
  async selectRole(request, reply) {
    const { role, vendor_id } = request.body || {}
    if (!role) {
      return reply.code(400).send(error('role is required', 'VALIDATION_ERROR'))
    }

    const userId = request.user.id

    if (vendor_id) {
      const assignment = await this.service.repo.findActiveShopStaffByUserAndShop(userId, vendor_id)
      if (!assignment) {
        return reply.code(403).send(error('No active assignment found for this vendor', 'ASSIGNMENT_NOT_FOUND'))
      }
      
      const accessToken = signAccessToken(
        {
          id: userId,
          phone: request.user.phone,
          role,
          shopId: vendor_id,
          shopRole: assignment.role,
          permissions: assignment.permissions || [],
        },
        { expiresIn: '24h' }
      )
      
      return reply.code(200).send(success({
        token: accessToken,
        vendor_id,
        role,
        permissions: assignment.permissions || []
      }, 'Role selected successfully'))
    } else {
      const user = await this.service.repo.findById(userId)
      if (user.role !== role) {
        // Allow CUSTOMER as base role for staff too
        const isStaff = (await this.service.repo.findActiveShopStaffByUserId(userId)).length > 0
        if (role !== 'CUSTOMER' || !isStaff) {
          return reply.code(403).send(error('Insufficient permissions for this role', 'FORBIDDEN'))
        }
      }

      const accessToken = signAccessToken(
        {
          id: userId,
          phone: user.phone,
          role
        },
        { expiresIn: '24h' }
      )

      return reply.code(200).send(success({
        token: accessToken,
        role
      }, 'Role selected successfully'))
    }
  }

  /**
   * POST /select-shop (legacy alias)
   */
  async selectShop(request, reply) {
    const { vendor_id } = request.body || {}
    request.body.role = 'VENDOR_OWNER' // default to owner for selectShop legacy call
    return this.selectRole(request, reply)
  }

  /**
   * POST /refresh-token
   */
  async refreshToken(request, reply) {
    const { refreshToken } = request.body

    if (!refreshToken) {
      return reply.code(400).send(error('Refresh token is required', 'REFRESH_TOKEN_REQUIRED'))
    }

    const result = await this.service.refreshToken(refreshToken)

    if (!result.success) {
      return reply.code(401).send(error(result.message, 'INVALID_REFRESH_TOKEN'))
    }

    reply.setCookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/v1/auth',
      maxAge: 7 * 24 * 60 * 60,
    })

    return reply.code(200).send(
      success({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      }, 'Token refreshed successfully')
    )
  }

  /**
   * POST /logout
   */
  async logout(request, reply) {
    await this.service.logout(request.user.id)
    reply.clearCookie('refreshToken', { path: '/api/v1/auth' })
    return reply.code(200).send(success(null, 'Logged out successfully'))
  }

  /**
   * DELETE /account
   */
  async deleteAccount(request, reply) {
    await this.service.deleteAccount(request.user.id)
    reply.clearCookie('refreshToken', { path: '/api/v1/auth' })
    return reply.code(200).send(success(null, 'Account deleted successfully'))
  }

  /**
   * GET /my-vendors
   */
  async myShops(request, reply) {
    const page = parseInt(request.query?.page, 10) || 1
    const limit = Math.min(parseInt(request.query?.limit, 10) || 20, 100)

    const result = await this.service.getMyShops(request.user.id, { page, limit })
    return reply.code(200).send(success(result, 'Shop assignments fetched'))
  }
}
