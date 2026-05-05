import multer from 'multer'

const ALLOWED_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       // .xlsx
  'application/msword',
])

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
      return cb(new Error('Only PDF, DOCX, and XLSX files are allowed'))
    }
    cb(null, true)
  },
}).array('documents', MAX_FILE_COUNT)