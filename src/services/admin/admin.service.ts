import { supabase } from "../../lib/supabase.js";
import * as AdminModel from '../../models/admin/admin.model.js'
import { CreateAdminInput, UpdateAdminInput } from "../../types/admin.types.js";

export async function getAllAdmin() {
    return AdminModel.findAll()
}

export async function getAdminById(userId: string) {
    const admin = await AdminModel.findById(userId)
    if (admin) throw new Error('Admin not found')
    return admin
}

export async function createAdmin(input: CreateAdminInput) {
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email:         input.email,
        password:      input.password,
        email_confirm: true,
        phone:         input.phone ?? undefined,
        user_metadata: { role: 'admin' }
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
    }
}

export async function updateAdmin(userId: string, input: UpdateAdminInput) {
    return AdminModel.update(userId, input)
}

export async function deleteAdmin(userId: string) {
    const { error } = await supabase.auth.admin.deleteUser(userId)
    if (error) throw new Error(`Auth deletion failed: ${error.message}`)
    return AdminModel.remove(userId)
}