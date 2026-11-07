import { supabase } from '../../lib/supabase.js'

/** A client whose contract with 8338 runs out inside the reminder window. */
export interface ContractReminderCandidate {
  client_id:            string
  user_id:              string
  company_name:         string | null
  contract_valid_until: string
  /** "<expiry>|<stage>|<channel>" → when sent. */
  contract_reminders:   Record<string, string>
  email:                string | null
  first_name:           string | null
  last_name:            string | null
}

/** Someone in the office the reminder goes to. */
export interface ContractReminderRecipient {
  user_id:    string
  role:       string
  email:      string | null
  first_name: string | null
}

/**
 * Active clients whose contract_valid_until falls between `fromDay` and `toDay`
 * (inclusive, `YYYY-MM-DD`). Archived and deactivated accounts are left out:
 * nobody can sign in to read it, and an archived client is no longer a client.
 */
export async function findExpiringBetween(fromDay: string, toDay: string): Promise<ContractReminderCandidate[]> {
  const { data, error } = await supabase
    .from('clients')
    .select(`
      client_id, user_id, company_name, contract_valid_until, contract_reminders,
      users!inner ( email, first_name, last_name, status, role )
    `)
    .not('contract_valid_until', 'is', null)
    .gte('contract_valid_until', fromDay)
    .lte('contract_valid_until', toDay)
    .eq('users.status', 'active')
    .eq('users.role', 'client')

  if (error) throw error

  return (data ?? []).map((row: any) => {
    const user = Array.isArray(row.users) ? row.users[0] : row.users
    return {
      client_id:            row.client_id,
      user_id:              row.user_id,
      company_name:         row.company_name ?? null,
      contract_valid_until: String(row.contract_valid_until).slice(0, 10),
      contract_reminders:   (row.contract_reminders ?? {}) as Record<string, string>,
      email:                user?.email ?? null,
      first_name:           user?.first_name ?? null,
      last_name:            user?.last_name ?? null,
    }
  })
}

/** The office told: every active Company Administrator, General Manager and Operations Manager. */
export async function findOfficeRecipients(): Promise<ContractReminderRecipient[]> {
  const { data, error } = await supabase
    .from('users')
    .select('user_id, role, email, first_name')
    .in('role', ['admin', 'general_manager', 'operations_manager'])
    .eq('status', 'active')
  if (error) throw error
  return (data ?? []) as ContractReminderRecipient[]
}

/** Record one stage + channel as sent for this expiry date (read-modify-write; one pass runs at a time). */
export async function markStage(clientId: string, key: string): Promise<void> {
  const { data, error } = await supabase.from('clients').select('contract_reminders').eq('client_id', clientId).maybeSingle()
  if (error) throw error
  const next = { ...((data?.contract_reminders ?? {}) as Record<string, string>), [key]: new Date().toISOString() }
  const { error: upErr } = await supabase.from('clients').update({ contract_reminders: next }).eq('client_id', clientId)
  if (upErr) throw upErr
}
