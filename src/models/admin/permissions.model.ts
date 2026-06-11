import { supabase } from '../../lib/supabase.js'
import { pickFlags } from '../../constants/modules.js'
import { ModulePermissionInput, ModulePermissionRow } from '../../types/permissions.types.js'

async function findByUser(userId: string): Promise<ModulePermissionRow[]> {
  const { data, error } = await supabase
    .from('module_permissions')
    .select('*')
    .eq('user_id', userId)

  if (error) throw error
  return (data ?? []) as ModulePermissionRow[]
}

// Replace the full permission matrix for a user in one shot:
// upsert every submitted module, then delete any module that was omitted.
async function replaceForUser(
  userId:     string,
  assignedBy: string | null,
  items:      ModulePermissionInput[],
): Promise<ModulePermissionRow[]> {
  const now = new Date().toISOString()

  const rows = items.map((item) => ({
    user_id:     userId,
    module_name: item.module_name,
    ...pickFlags(item),
    assigned_by: assignedBy,
    updated_at:  now,
  }))

  if (rows.length > 0) {
    const { error: upsertError } = await supabase
      .from('module_permissions')
      .upsert(rows, { onConflict: 'user_id,module_name' })
    if (upsertError) throw upsertError
  }

  // Remove modules that were not part of this submission.
  const keep = items.map((i) => i.module_name)
  let del = supabase.from('module_permissions').delete().eq('user_id', userId)
  if (keep.length > 0) {
    del = del.not('module_name', 'in', `(${keep.map((k) => `"${k}"`).join(',')})`)
  }
  const { error: deleteError } = await del
  if (deleteError) throw deleteError

  return findByUser(userId)
}

export { findByUser, replaceForUser }
