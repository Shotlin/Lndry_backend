import { z } from 'zod'

/**
 * Validation schema for the Rider Assignment Settings module (Phase 5 of
 * the rider-assignment initiative — see CLAUDE.md).
 */
export const updateRiderAssignmentSettingsSchema = z.object({
  broadcast_timeout_minutes: z.number().int().min(1).max(1440),
})
