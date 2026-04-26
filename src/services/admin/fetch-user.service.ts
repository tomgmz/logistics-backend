import * as FetchUsersModel from '../../models/admin/fetch-users.models.js'
import { GetUsersQuery, GetUsersResult, UserStatsResult } from '../../types/fetch-user.types.js'

export async function getUsers(query: GetUsersQuery): Promise<GetUsersResult> {
  return FetchUsersModel.findAllUsers(query)
}

export async function getUserStats(): Promise<UserStatsResult> {
  return FetchUsersModel.countUsersByStatus()
}