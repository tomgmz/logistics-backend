import multer from 'multer'

/**
 * Uploads for client-supplied paperwork: booking documents, billing summaries,
 * and proof of payment.
 *
 * Images are accepted alongside office formats because most of what clients
 * actually attach is photographed rather than scanned — a signed DR, a deposit
 * slip, a bank transfer confirmation. HEIC is included deliberately: it is what
 * an iPhone produces by default, and rejecting it turns "attach a photo" into a
 * support conversation.
 */
const ALLOWED_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       // .xlsx
  'application/msword',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
])

/** What the message should say when a file is turned away. */
const ALLOWED_LABEL = 'PDF, DOCX, XLSX, JPG, PNG, WEBP or HEIC'

const MAX_FILE_SIZE  = 10 * 1024 * 1024  // 10 MB per file
const MAX_FILE_COUNT = 3

const storage = multer.memoryStorage()

export const uploadDocuments = multer({
  storage,
  limits: {
    fileSize:  MAX_FILE_SIZE,
    files:     MAX_FILE_COUNT,
  },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIMES.has(file.mimetype)) {
      return cb(new Error(`Only ${ALLOWED_LABEL} files are allowed`))
    }
    cb(null, true)
  },
}).array('documents', MAX_FILE_COUNT)
