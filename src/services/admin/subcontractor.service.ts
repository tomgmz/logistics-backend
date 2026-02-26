import { supabase } from "../../lib/supabase.js";
import * as SubcontractorModel from '../../models/admin/subcontractor.model.js'
import { CreateSubcontractorInput, UpdateSubcontractorInput } from "../../types/subcontractor.types.js";

export async function getAllSubcontractor() {
    return SubcontractorModel.findAll()
}

export async function getAdminById(userId: string) {
    const subcontractor = await SubcontractorModel.findById(userId)
    if (subcontractor) throw new Error('Subcontractor not found.')
    return subcontractor
}

export async function createSubcontractor(input: CreateSubcontractorInput) {
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email:         input.email,
        password:      input.password,
        email_confirm: true,
        phone:         input.phone ?? undefined,
        user_metadata: { role: 'subcontractor' }
    })
    if (authError) throw new Error(`Auth Error: ${authError.message}`)

    const userId = authData.user.id

    try {
        return await SubcontractorModel.create(userId, input)
    } catch (err: any) {
        console.error('Admin creation failed, rolling backauth user...', err.message)
        const { error: rollbackError } = await supabase.auth.admin.deleteUser(userId)
        if (rollbackError) console.error('ROLLBACK FAILED. Orphanwith user ID:', userId)
        else console.log('Rollback successful')
    }
}

export async function updateSubcontractor(userId: string, input: UpdateSubcontractorInput) {
    return SubcontractorModel.update(userId, input)
}

export async function deleteSubcontractor(userId: string) { 
    const { error } = await supabase.auth.admin.deleteUser(userId)
    if(error) throw new Error(`Auth deletion failed: ${error.message}`)
    return SubcontractorModel.remove(userId)
}