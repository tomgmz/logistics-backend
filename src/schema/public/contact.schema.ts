import { z } from 'zod'
import {
  emailField,
  firstNameField,
  lastNameField,
  optionalMobileField,
} from '../admin/shared.schema.js'

export const CONTACT_ROLES = ['fmcg', 'shipper', 'other'] as const

// The landing page's "Contact our logistics experts" form. Names, email and
// phone go through the same rules as every account in the system.
export const contactInquirySchema = z.object({
  first_name: firstNameField(),
  last_name:  lastNameField(),
  email:      emailField(),
  phone:      optionalMobileField(),
  role:       z.enum(CONTACT_ROLES, { error: 'Choose fmcg, shipper or other' }),
  message:    z
    .string()
    .trim()
    .min(10, 'Message must be at least 10 characters')
    .max(2000, 'Message is too long (2000 characters at most)'),
  // Honeypot: a field no person can see. Anything in it means a bot filled the
  // form, and the route drops the message while still answering success.
  website:    z.string().optional(),
})

export type ContactInquiryInput = z.infer<typeof contactInquirySchema>
