import { supabase } from '../../lib/supabase.js'
import * as ClientModel from '../../models/admin/client.model.js'
import { activateUserWithUnban, deactivateUserWithBan } from './user-auth-status.service.js'
import { CreateClientInput, UpdateClientInput } from '../../types/client.types.js'
import { logEvent } from '../../lib/log-event.js'
import { generateSecurePassword, sendWelcomeEmail } from '../../lib/brevo-mailer.js'

export async function getAllClient() {
  return ClientModel.findAll()
}

export async function getClientById(userId: string) {
  const client = await ClientModel.findById(userId)
  if (!client) throw new Error('Client not found')
  return client
}

export async function createClient(
  input:   CreateClientInput,
  actorId?: string | null,
  ip?:      string | null,
) {
  const password = generateSecurePassword()

  // 1. Create Supabase Auth user with the generated password
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email:         input.email,
    password,
    email_confirm: true,
    user_metadata: { role: 'client' },
  })
  if (authError) throw new Error(`Auth Error: ${authError.message}`)

  const userId = authData.user.id

  try {
    // 2. Insert into public.users + public.clients
    const result = await ClientModel.create(userId, input)

    // 3. Fire welcome email — non-blocking: a failure logs but does NOT roll back
    sendWelcomeEmail({
      to:        input.email,
      firstName: input.first_name ?? null,
      role:      'client',
      password,
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('RAW DB ERROR:', JSON.stringify(err, null, 2))
      console.error(`WELCOME_EMAIL_FAILED for client ${userId}:`, msg)
    })

    logEvent({
      user_id:     actorId,
      log_type:    'user_activity',
      action:      'client_created',
      description: `Client ${input.email} created (user: ${userId})`,
      ip_address:  ip,
    })

    return result
  } catch (err: unknown) {
    // Roll back the Supabase Auth user so no orphan is left
    const msg = err instanceof Error ? err.message : String(err)
    console.error('RAW DB ERROR:', JSON.stringify(err, null, 2))
    console.error('Client creation failed, rolling back auth user...', msg)
    const { error: rollbackError } = await supabase.auth.admin.deleteUser(userId)
    if (rollbackError) {
      console.error('ROLLBACK FAILED. Orphan auth user with ID:', userId)
    } else {
      console.log('Rollback successful.')
    }
    throw new Error(`Client creation failed: ${msg}`)
  }
}

export async function updateClient(
  userId:   string,
  input:    UpdateClientInput,
  actorId?: string | null,
  ip?:      string | null,
) {
  if (input.email) {
    const { error: authError } = await supabase.auth.admin.updateUserById(userId, {
      email: input.email,
    })
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

export async function deleteClient(
  userId:   string,
  actorId?: string | null,
  ip?:      string | null,
) {
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

export async function deactivateClient(
  userId:   string,
  actorId?: string | null,
  ip?:      string | null,
) {
  return deactivateUserWithBan(userId, 'client', 'client_deactivated', 'Client', actorId, ip)
}

export async function activateClient(
  userId:   string,
  actorId?: string | null,
  ip?:      string | null,
) {
  return activateUserWithUnban(userId, 'client', 'client_activated', 'Client', actorId, ip)
}