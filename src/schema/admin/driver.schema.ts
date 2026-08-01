import { z } from 'zod'
import {
  coreCreateFields,
  coreUpdateFields,
  licenseNumberField,
  licenseExpiryField,
} from './shared.schema.js'

export const createDriverSchema = z.object({
  ...coreCreateFields(),
  license_number:    licenseNumberField(),
  license_expiry:    licenseExpiryField(),
  license_image_url: z.string().url().optional().nullable(),
})

export const updateDriverSchema = z.object({
  ...coreUpdateFields(),
  license_number:    licenseNumberField().optional(),
  license_expiry:    licenseExpiryField().optional(),
  license_image_url: z.string().url().optional().nullable(),
})