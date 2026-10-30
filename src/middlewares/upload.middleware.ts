import multer from 'multer'
import { withFileUrls } from './fileUrls.middleware.js'

const storage = multer.memoryStorage()

export const uploadSingle = withFileUrls(multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'))
    }
    cb(null, true)
  },
}).single('image'))

/** A photo sent in chat (field `image`), up to 10 MB. */
export const uploadChatPhoto = withFileUrls(multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'))
    }
    cb(null, true)
  },
}).single('image'))
