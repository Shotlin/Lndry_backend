export const ROLES = {
  CUSTOMER: 'CUSTOMER',
  VENDOR_APPLICANT: 'VENDOR_APPLICANT',
  VENDOR_OWNER: 'VENDOR_OWNER',
  VENDOR_STAFF: 'VENDOR_STAFF',
  RIDER: 'RIDER',
  ADMIN: 'ADMIN',
  FINANCE_ADMIN: 'FINANCE_ADMIN',
  SUPER_ADMIN: 'SUPER_ADMIN',
}

export const ALL_ROLES = Object.values(ROLES)

/** Roles allowed to access delivery / rider endpoints */
export const RIDER_ROLES = [ROLES.RIDER]

/** Roles that operate within a vendor context (require vendor_id scope) */
export const VENDOR_ROLES = [ROLES.VENDOR_OWNER, ROLES.VENDOR_STAFF]
