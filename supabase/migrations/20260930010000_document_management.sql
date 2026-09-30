-- Document Management: staff-uploaded paperwork, on the reserved `documents` table.
--
-- The Document Management page is a library over every file the system already
-- keeps (client transaction documents, pickup and delivery proof photos, fleet
-- odometer photos and service receipts — read straight from their own tables),
-- plus paperwork staff attach themselves: signed delivery receipts that came
-- back on paper, trip tickets, daily time records, purchase orders. Only that
-- last kind lives here.
--
-- The table predates the booking model and could only point at a delivery or a
-- maintenance record. A delivery row only exists once a booking is assigned, but
-- a purchase order arrives before that, so documents now point at the booking
-- directly. It is empty, so the type changes below touch no data.

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS booking_id    uuid REFERENCES public.bookings(booking_id) ON DELETE CASCADE,
  -- What the uploader called the file; the Cloudinary name is sanitised.
  ADD COLUMN IF NOT EXISTS original_name text,
  ADD COLUMN IF NOT EXISTS public_id     text,
  ADD COLUMN IF NOT EXISTS file_format   varchar(20),
  ADD COLUMN IF NOT EXISTS bytes         integer,
  ADD COLUMN IF NOT EXISTS notes         text,
  -- Archiving hides a document without touching its review status or its file:
  -- a signed receipt is evidence, so nothing here is ever hard-deleted.
  ADD COLUMN IF NOT EXISTS archived_at   timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by   uuid REFERENCES public.users(user_id);

-- Naive timestamps elsewhere in this table's era are UTC wall-clock; the table
-- is empty, so this is a free switch to the timezone-aware type.
ALTER TABLE public.documents
  ALTER COLUMN uploaded_at TYPE timestamptz USING uploaded_at AT TIME ZONE 'UTC',
  ALTER COLUMN reviewed_at TYPE timestamptz USING reviewed_at AT TIME ZONE 'UTC';

ALTER TABLE public.documents DROP CONSTRAINT IF EXISTS chk_documents_has_reference;
ALTER TABLE public.documents ADD CONSTRAINT chk_documents_has_reference
  CHECK (booking_id IS NOT NULL OR delivery_id IS NOT NULL OR maintenance_id IS NOT NULL);

ALTER TABLE public.documents DROP CONSTRAINT IF EXISTS documents_document_type_check;
ALTER TABLE public.documents ADD CONSTRAINT documents_document_type_check
  CHECK (document_type IN (
    'delivery_receipt', 'trip_ticket', 'dtr', 'proof_of_delivery',
    'purchase_order', 'maintenance_record', 'other'
  ));

CREATE INDEX IF NOT EXISTS idx_documents_booking_id  ON public.documents (booking_id);
CREATE INDEX IF NOT EXISTS idx_documents_uploaded_at ON public.documents (uploaded_at DESC);

-- Live signal for the Document Management page. Bookings and vehicle upkeep
-- already signal on live:bookings / live:trucks; trips, trip stops and
-- destinations carry the proof photos but did not signal anything the library
-- listens to. Separate trigger names so an existing `live_signal` trigger on
-- any of these tables is left alone.
DROP TRIGGER IF EXISTS live_signal ON public.documents;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('document_id', 'live:documents');

DROP TRIGGER IF EXISTS live_signal_documents ON public.booking_trips;
CREATE TRIGGER live_signal_documents AFTER INSERT OR UPDATE OF pickup_proof_photo_url OR DELETE ON public.booking_trips
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('trip_id', 'live:documents');

DROP TRIGGER IF EXISTS live_signal_documents ON public.booking_trip_stops;
CREATE TRIGGER live_signal_documents AFTER INSERT OR UPDATE OF proof_photo_url OR DELETE ON public.booking_trip_stops
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('trip_stop_id', 'live:documents');

DROP TRIGGER IF EXISTS live_signal_documents ON public.booking_destinations;
CREATE TRIGGER live_signal_documents AFTER INSERT OR UPDATE OF proof_photo_url OR DELETE ON public.booking_destinations
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('destination_id', 'live:documents');
