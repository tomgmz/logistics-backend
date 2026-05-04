import { supabase } from '../../lib/supabase.js'
import * as ClientModel from '../../models/admin/client.model.js'
import { CreateClientInput, UpdateClientInput } from '../../types/client.types.js'
import { logEvent } from '../../lib/log-event.js'

export async function getAllClient() {
  return ClientModel.findAll()
}

export async function getClientById(userId: string) {
  const client = await ClientModel.findById(userId)
  if (!client) throw new Error('Client not found')
  return client
}

export async function createClient(input: CreateClientInput, actorId?: string | null, ip?: string | null) {
  const e164Phone = input.phone ? '+63' + input.phone.slice(1) : undefined

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email:         input.email,
    email_confirm: true,
    phone:         e164Phone ?? undefined,
    user_metadata: { role: 'client' },
  })
  if (authError) throw new Error(`Auth Error: ${authError.message}`)

  const userId = authData.user.id

  try {
    const result = await ClientModel.create(userId, input)

    logEvent({
      user_id:     actorId,
      log_type:    'user_activity',
      action:      'client_created',
      description: `Client ${input.email} created (user: ${userId})`,
      ip_address:  ip,
    })

    return result
  } catch (err: any) {
    console.error('Client creation failed, rolling back auth user...', err.message)
    const { error: rollbackError } = await supabase.auth.admin.deleteUser(userId)
    if (rollbackError) console.error('ROLLBACK FAILED. Orphan with user ID:', userId)
    else console.log('Rollback successful.')
    throw new Error(`Client creation failed: ${err.message}`)
  }
}

export async function updateClient(userId: string, input: UpdateClientInput, actorId?: string | null, ip?: string | null) {
  if (input.email) {
    const { error: authError } = await supabase.auth.admin.updateUserById(userId, { email: input.email })
    if (authError) throw new Error(`Auth update failed: ${authError.message}`)
  }

  const result = await ClientModel.update(userId, input)

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      'client_updated',
    description: `Client ${userId} updated`,
    ip_address:  ip,
  })

  return result
}

export async function deleteClient(userId: string, actorId?: string | null, ip?: string | null) {
  const result = await ClientModel.remove(userId)

  logEvent({
    user_id:     actorId,
    log_type:    'user_activity',
    action:      'client_deleted',
    description: `Client ${userId} deleted`,
    ip_address:  ip,
  })

  return result
}