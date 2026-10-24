-- What a rejected booking looked like before the client corrected and
-- resubmitted it, and what they resubmitted.
--
-- A resubmission rewrites the SAME booking in place (same id, same reference,
-- resubmission_count + 1; see BookingModel.resubmit), which used to throw the
-- old values away. Each resubmission now keeps one row here with both sides, so
-- the client, the approver and the transaction history can show the old values
-- next to the new ones.
--
-- Both sides come from booking_snapshot(), taken inside the resubmit
-- transaction: before_snapshot just before the rewrite (it also carries the
-- rejection that sent it back), after_snapshot just after. Same function, same
-- shape, so the two can be compared key by key. Staff edits made after the
-- resubmission do not touch these rows.

-- The client-visible content of one booking as a jsonb document: the booking's
-- own request fields, its drop-offs in order, and its cargo lines with the
-- catalogue names resolved (a renamed product must not show as a change).
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

CREATE TABLE IF NOT EXISTS public.booking_revisions (
  revision_id      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       uuid        NOT NULL REFERENCES public.bookings(booking_id) ON DELETE CASCADE,
  -- 1 for the first resubmission; equals bookings.resubmission_count after it.
  revision_number  integer     NOT NULL,
  before_snapshot  jsonb       NOT NULL,
  after_snapshot   jsonb       NOT NULL,
  resubmitted_by   uuid        REFERENCES public.users(user_id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id, revision_number)
);

-- Read and written only by the backend (service role).
ALTER TABLE public.booking_revisions ENABLE ROW LEVEL SECURITY;
