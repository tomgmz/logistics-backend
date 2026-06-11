import { z } from 'zod'
import { MODULE_KEYS } from '../../constants/modules.js'

const flag = z.boolean().optional().default(false)

export const replacePermissionsSchema = z.object({
  permissions: z
    .array(
      z.object({
        module_name: z.enum(MODULE_KEYS as unknown as [string, ...string[]]),
        can_view:    flag,
        can_create:  flag,
        can_edit:    flag,
        can_delete:  flag,
        can_export:  flag,
      }),
    )
    .max(MODULE_KEYS.length),
})

export type ReplacePermissionsBody = z.infer<typeof replacePermissionsSchema>
