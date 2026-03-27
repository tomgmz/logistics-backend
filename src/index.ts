import dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from "express-rate-limit";
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';
import basicAuth from 'express-basic-auth';

import { swaggerSpec } from './swagger/swagger.config.js';
import adminRoutes from './routes/admin.route.js';
import clientRoutes from './routes/client.routes.js';
import routeOptimizationRoutes from './routes/routeOptimization.route.js';
import authRoutes from './routes/auth.route.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// SECURITY

app.use(helmet({
  contentSecurityPolicy: IS_PRODUCTION ? {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  } : false,
}));

// CORS
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
  'http://localhost:3000',
  'https://logistics-frontend-seven.vercel.app',
  'http://localhost:4000',
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  exposedHeaders: ['x-access-token'],
}));

// RATE LIMITER
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many requests, please try again later.' },
});

app.use(globalLimiter);

// MIDDLEWARE
app.use(cookieParser(process.env.COOKIE_SECRET));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

if (!IS_PRODUCTION) {
  app.use(morgan('dev'));
  app.use((req: Request, res: Response, next: NextFunction) => {
    console.log(`${req.method} ${req.path}`, {
      cookies: Object.keys(req.cookies || {}),
      body: req.method !== 'GET' ? req.body : undefined,
    });
    next();
  });
}

// SWAGGER
app.use('/api-docs',
  basicAuth({
    users: { [process.env.SWAGGER_USER!]: process.env.SWAGGER_PASSWORD! },
    challenge: true,
  }),
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec)
);

// ROUTES
app.use('/api', adminRoutes);
app.use('/api/booking', clientRoutes);
app.use('/api/route-optimization', routeOptimizationRoutes);
app.use('/api/auth', authLimiter, authRoutes);

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
  });
});

app.get('/', (req: Request, res: Response) => {
  res.json({ status: 'OK', message: 'Logistics Backend API is running...' });
});

// ERROR HANDLING

app.use((req: Request, res: Response) => {
  res.status(404).json({
    status: 'error',
    message: 'Route not found',
  });
});

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('GLOBAL ERROR:', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  const message = IS_PRODUCTION
    ? 'Internal server error'
    : err.message;

  res.status(500).json({
    status: 'error',
    message,
  });
});


app.post('/api/auth/login', async (req: Request, res: Response) => {
  const { username, password } = req.body;
  // validate credentials...
  const token = 'jwt-token-here';

  res.cookie('auth-token', token, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: IS_PRODUCTION ? 'none' : 'lax',
    maxAge: 1000 * 60 * 60 * 24,
  });

  res.json({ status: 'success', message: 'Logged in' });
});

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Allowed origins:`, allowedOrigins);
});

// Graceful shutdown
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

export default app;