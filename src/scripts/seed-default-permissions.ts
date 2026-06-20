/**
 * One-time backfill: seed default module permissions for existing managed-role
 * users that have no rows yet, so they move from "full access" to their role's
 * default tiers — matching what new users now get at creation time.
 *
 * Idempotent: users that already have any module_permissions row are skipped, so
 * IT-Admin customizations are never overwritten. Safe to re-run.
 *
 * Run with:  npx tsx src/scripts/seed-default-permissions.ts
 */
import { supabase } from '../lib/supabase.js'
import * as PermissionsModel from '../models/admin/permissions.model.js'
import {
  MANAGED_ROLES,
  defaultPermissionsForRole,
} from '../constants/modules.js'

async function main() {
  // All managed-role users.
  const { data: users, error: usersError } = await supabase
    .from('users')
    .select('user_id, role')
    .in('role', MANAGED_ROLES as unknown as string[])

  if (usersError) throw usersError
  if (!users || users.length === 0) {
    console.log('No managed-role users found. Nothing to do.')
    return
  }

  // Users that already have at least one permission row — skip these.
  const { data: existing, error: existingError } = await supabase
    .from('module_permissions')
    .select('user_id')

  if (existingError) throw existingError
  const hasRows = new Set((existing ?? []).map((r) => r.user_id))

  let seeded = 0
  let skipped = 0
  for (const u of users) {
    if (hasRows.has(u.user_id)) {
      skipped++
      continue
    }
    await PermissionsModel.replaceForUser(
      u.user_id,
      null,
      defaultPermissionsForRole(u.role),
    )
    seeded++
    console.log(`Seeded defaults for ${u.user_id} (${u.role})`)
  }

  console.log(`\nDone. Seeded ${seeded}, skipped ${skipped} (already had rows).`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Backfill failed:', err)
    process.exit(1)
  })
