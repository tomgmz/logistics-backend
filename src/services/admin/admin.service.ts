import { supabase } from "../../lib/supabase.js";
import * as AdminModel from '../../models/admin/admin.model.js'
import { CreateAdminInput, UpdateAdminInput } from "../../types/admin.types.js";

export async function getAllAdmin() {
    return AdminModel.findAll()
}

export async function getAdminById(userId: string) {
    const admin = await AdminModel.findById(userId)
    if (!admin) throw new Error('Admin not found')
    return admin
}

export async function createAdmin(input: CreateAdminInput) {
    const e164Phone = input.phone ? '+63' + input.phone.slice(1) : undefined
    
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email:         input.email,
        email_confirm: true,
        phone:         e164Phone ?? undefined,
        user_metadata: {
            role: 'admin',
            display_name: input.username,
        }
    })
    if(authError) throw new Error(`Auth Error: ${authError.message}`)

    const userId = authData.user.id

    try {
        return await AdminModel.create(userId, input)
    } catch (err: any) {
        console.error('Admin creation failed, rolling back auth user...', err.message)
        const { error: rollbackError } = await supabase.auth.admin.deleteUser(userId)
        if (rollbackError) console.error('ROLLBACK FAILED. Orphan with user ID:', userId)
        else console.log('Rolback successful')
        throw err
    }
}

export async function updateAdmin(userId: string, input: UpdateAdminInput) {
    if (input.email) {
        const { error: authError } = await supabase.auth.admin.updateUserById(userId, {
            email: input.email,
        })
        if (authError) throw new Error(`Auth update failed: ${authError.message}`)
    }

    return AdminModel.update(userId, input)
}

export async function deleteAdmin(userId: string) {
  return AdminModel.remove(userId)
}