import { ModuleKey, ModulePermissionFlags } from '../constants/modules.js'

// A single row of the module_permissions table.
export interface ModulePermissionRow extends ModulePermissionFlags {
  permission_id: string
  user_id:       string
  module_name:   string
  assigned_by:   string | null
  created_at:    string
  updated_at:    string
}

// What the IT Admin submits: granular flags per module.
export interface ModulePermissionInput extends ModulePermissionFlags {
  module_name: ModuleKey
}

// Compact shape attached to the user's session (/me) and returned to the UI.
export interface ModulePermissionSummary extends ModulePermissionFlags {
  module_key: string
}
