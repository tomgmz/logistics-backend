import { z } from 'zod'

// ── Handling Codes ──────────────────────────────────────────────────────────

export const createHandlingCodeSchema = z.object({
  code:        z.string().min(1).max(20).trim().toUpperCase(),
  name:        z.string().min(1).max(100).trim(),
  description: z.string().max(500).optional(),
  type:        z.enum(['standard', 'additional']).default('standard'),
  is_active:   z.boolean().optional(),
})

export const updateHandlingCodeSchema = z.object({
  code:        z.string().min(1).max(100).trim().toUpperCase().optional(),
  name:        z.string().min(1).max(100).trim().optional(),
  description: z.string().max(500).optional().nullable(),
  type:        z.enum(['standard', 'additional']).optional(),
  is_active:   z.boolean().optional(),
})

// ── Commodities ─────────────────────────────────────────────────────────────

export const createCommoditySchema = z.object({
  name:        z.string().min(1).max(100).trim(),
  description: z.string().max(500).optional(),
  category:    z.string().max(100).trim().optional(),
  is_active:   z.boolean().optional(),
})

export const updateCommoditySchema = z.object({
  name:        z.string().min(1).max(100).trim().optional(),
  description: z.string().max(500).optional().nullable(),
  category:    z.string().max(100).trim().optional().nullable(),
  is_active:   z.boolean().optional(),
})

// ── Products ────────────────────────────────────────────────────────────────

export const createProductSchema = z.object({
  commodity_id: z.string().uuid(),
  name:         z.string().min(1).max(100).trim(),
  description:  z.string().max(500).optional(),
  unit:         z.string().max(50).trim().optional(),
  is_active:    z.boolean().optional(),
})

export const updateProductSchema = z.object({
  commodity_id: z.string().uuid().optional(), // optional on update
  name:         z.string().min(1).max(100).trim().optional(),
  description:  z.string().max(500).optional().nullable(),
  unit:         z.string().max(50).trim().optional().nullable(),
  is_active:    z.boolean().optional(),
})

// ── Booking cargo item combobox fields ──────────────────────────────────────
// Used when validating cargo items inside a booking submission.
// Each pair is mutually exclusive — either the FK id or the free text, not both.

export const cargoItemComboboxSchema = z.object({
  commodity_id:   z.string().uuid().optional().nullable(),
  commodity_text: z.string().max(200).optional().nullable(),
  product_id:     z.string().uuid().optional().nullable(),
  product_text:   z.string().max(200).optional().nullable(),
  shc_id:         z.string().uuid().optional().nullable(),
  shc_text:       z.string().max(50).optional().nullable(),
  ashc_id:        z.string().uuid().optional().nullable(),
  ashc_text:      z.string().max(50).optional().nullable(),
}).refine(
  (d) => !(d.commodity_id && d.commodity_text),
  { message: 'Provide either commodity_id or commodity_text, not both' }
).refine(
  (d) => !(d.product_id && d.product_text),
  { message: 'Provide either product_id or product_text, not both' }
).refine(
  (d) => !(d.shc_id && d.shc_text),
  { message: 'Provide either shc_id or shc_text, not both' }
).refine(
  (d) => !(d.ashc_id && d.ashc_text),
  { message: 'Provide either ashc_id or ashc_text, not both' }
)