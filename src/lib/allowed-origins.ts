/** The web origins allowed to call the API (CORS) and to frame its files (GET /api/files). */
export const allowedOrigins: string[] = process.env.ALLOWED_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean) || [
  'http://localhost:3000',
  'https://8338logistics.delivery',
  'https://www.8338logistics.delivery',
  'https://logistics-frontend-seven.vercel.app',
  'http://localhost:4000',
  'http://localhost:8081',
]
