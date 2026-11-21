-- The size unit the client typed a cargo line in (2026-11-21).
--
-- length_cm / width_cm / height_cm stay the one stored figure: the volume, the
-- vehicle fit check and every calculation read cm. dimension_unit only says how
-- the client wrote the size, so every screen can show it back the way it was
-- typed (cm / 100 for m, cm / 2.54 for in). NULL = cm (every line written
-- before this, and lines from an older web build).

ALTER TABLE public.booking_cargo_items
  ADD COLUMN IF NOT EXISTS dimension_unit text
  CHECK (dimension_unit IN ('cm', 'm', 'in'));

COMMENT ON COLUMN public.booking_cargo_items.dimension_unit IS
  'Unit the client typed the size in (cm, m, in). Sizes are stored in cm; this is for display only. NULL = cm.';

-- The resubmission snapshot carries the unit, so "before / after" shows sizes as typed.
CREATE OR REPLACE FUNCTION public.booking_snapshot(p_booking_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'origin',                 b.origin,
    'schedule_date',          b.schedule_date,
    'call_time',              b.call_time,
    'truck_type_needed',      b.truck_type_needed,
    'required_volume_cbm',    b.required_volume_cbm,
    'required_weight_kg',     b.required_weight_kg,
    'required_length_cm',     b.required_length_cm,
    'required_net_weight_kg', b.required_net_weight_kg,
    'stackable_required',     b.stackable_required,
    'non_stackable_cargo',    b.non_stackable_cargo,
    'transaction_documents',  COALESCE(to_jsonb(b.transaction_documents), '[]'::jsonb),
    -- The decision this version received (set on the "before" side only).
    'gm_status',              b.gm_status,
    'rejection_reason',       b.rejection_reason,
    'rejected_role',          CASE WHEN b.gm_status = 'rejected' THEN b.gm_reviewed_role ELSE cu.role END,
    'rejected_at',            CASE WHEN b.gm_status = 'rejected' THEN b.gm_reviewed_at ELSE b.cancelled_at END,
    'destinations', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'sequence_order', d.sequence_order,
               'address',        d.address,
               'notes',          d.notes
             ) ORDER BY d.sequence_order), '[]'::jsonb)
        FROM public.booking_destinations d
       WHERE d.booking_id = b.booking_id
    ),
    'cargo_items', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'dropoff_sequence_order', d.sequence_order,
               'commodity',  COALESCE(cm.name, c.commodity_text),
               'product',    COALESCE(p.name,  c.product_text),
               'unit',       p.unit,
               'shc',        COALESCE(shc.code, c.shc_text),
               'ashc',       COALESCE(ashc.code, c.ashc_text),
               'quantity',   c.quantity,
               'weight_kg',  c.weight_kg,
               'volume_cbm', c.volume_cbm,
               'length_cm',  c.length_cm,
               'width_cm',   c.width_cm,
               'height_cm',  c.height_cm,
               'dimension_unit', c.dimension_unit,
               'notes',      c.notes
             ) ORDER BY d.sequence_order NULLS LAST, c.created_at, c.item_id), '[]'::jsonb)
        FROM public.booking_cargo_items c
        LEFT JOIN public.booking_destinations d    ON d.destination_id      = c.destination_id
        LEFT JOIN public.commodities          cm   ON cm.commodity_id       = c.commodity_id
        LEFT JOIN public.products             p    ON p.product_id          = c.product_id
        LEFT JOIN public.handling_codes       shc  ON shc.handling_code_id  = c.shc_id
        LEFT JOIN public.handling_codes       ashc ON ashc.handling_code_id = c.ashc_id
       WHERE c.booking_id = b.booking_id
    )
  )
  FROM public.bookings b
  LEFT JOIN public.users cu ON cu.user_id = b.cancelled_by
  WHERE b.booking_id = p_booking_id
$$;

REVOKE ALL ON FUNCTION public.booking_snapshot(uuid) FROM PUBLIC, anon, authenticated;
