import { Request, Response } from 'express'
import { getRequestMeta } from '../../lib/controller-utils.js'
import { statusOf } from '../../lib/http-error.js'
import { errorMessage } from '../../lib/error-message.js'
import * as AppReleaseService from '../../services/admin/app-release.service.js'

function fail(res: Response, err: unknown) {
  res.status(statusOf(err)).json({ status: 'error', message: errorMessage(err) })
}

export async function createUploadUrl(req: Request, res: Response) {
  try {
    const data = await AppReleaseService.createUploadUrl(req.body.file_name, req.body.size_bytes)
    res.status(200).json({ status: 'success', data })
  } catch (err) { fail(res, err) }
}

export async function publishRelease(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const data = await AppReleaseService.publishRelease(req.body, userId)
    res.status(201).json({ status: 'success', message: 'App version published', data })
  } catch (err) { fail(res, err) }
}

export async function listReleases(_req: Request, res: Response) {
  try {
    const data = await AppReleaseService.listReleases()
    res.status(200).json({ status: 'success', data })
  } catch (err) { fail(res, err) }
}
