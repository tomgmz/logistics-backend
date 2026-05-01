import { Request } from 'express'

export function getRequestMeta(req: Request): { userId: string | null; ip: string | null } {
  return {
    userId: req.user?.sub ?? null,
    ip:     Array.isArray(req.ip) ? req.ip[0] : (req.ip ?? null),
  }
}

export function param(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value
}