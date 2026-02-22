import { supabase } from '../lib/supabase.js'
import { CreateUserDTO } from '../types/user.types.js'

export const createUserService = async (userData: CreateUserDTO) => {
  //create auth.user row
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email: userData.email,
    password: userData.password,
    email_confirm: true,
    phone: userData.phone,
    user_metadata: { role: userData.role } 
  })

  if (authError) throw new Error(`Auth Error: ${authError.message}`)
  const userId = authData.user.id

  try {
    // insert to users table
    const { error: userError } = await supabase
      .from('users')
      .insert({
        user_id: userId,
        username: userData.username,
        email: userData.email,
        first_name: userData.first_name,
        last_name: userData.last_name,
        middle_initial: userData.middle_initial,
        suffix: userData.suffix,
        phone: userData.phone,
        role: userData.role,
        created_by: userData.created_by
      })

    if (userError) throw userError

    //role insertion (specific)
    switch (userData.role) {
      case 'driver':
        const { error: driverErr } = await supabase.from('drivers').insert({
          user_id: userId,
          license_number: userData.license_number,
          license_expiry: userData.license_expiry,
          is_subcontractor_driver: userData.is_subcontractor_driver ?? false,
          subcontractor_id: userData.subcontractor_id ?? null,
        })
        if (driverErr) throw driverErr
        break

      case 'client':
        const { error: clientErr } = await supabase.from('clients').insert({
          user_id: userId,
          company_name: userData.company_name ?? null,
          billing_address: userData.billing_address ?? null,
          payment_terms: userData.payment_terms ?? null,
        })
        if (clientErr) throw clientErr
        break

      case 'subcontractor':
        const { error: subErr } = await supabase.from('subcontractors').insert({
          user_id: userId,
          subcontractor_type: userData.subcontractor_type,
          company_name: userData.subcon_company_name ?? null,
          business_permit: userData.business_permit ?? null,
        })
        if (subErr) throw subErr
        break
    }

    //logs
    await supabase.from('system_logs').insert({
      user_id: userData.created_by ?? null,
      log_type: 'user_activity',
      action: 'user_creation',
      description: `User ${userData.username} (${userData.role}) created.`,
    })

    return authData.user

  } catch (err: any) {
    //rollback on fail
    await supabase.auth.admin.deleteUser(userId)
    throw new Error(`Database Error: ${err.message}`)
  }
}