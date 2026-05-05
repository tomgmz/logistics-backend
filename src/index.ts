import dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';
import basicAuth from 'express-basic-auth';
import { swaggerSpec } from './swagger/swagger.config.js';
import adminRoutes from './routes/admin.route.js';
import clientRoutes from './routes/client.routes.js';
import routeOptimizationRoutes from './routes/routeOptimization.route.js';
import authRoutes from './routes/auth.route.js';
import directionsRouter from './routes/directions.routes.js'
import driverRoutes from './routes/driver.route.js'
import uploadRoutes from './routes/upload.route.js'
import { globalLimiter } from './middlewares/rateLimit.middleware.js';

dotenv.config();

const app = express();
const PORT: number = Number(process.env.PORT) || 4000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

app.use((req, res, next) => {
  console.log(`>>> ${req.method} ${req.path}`)
  next()
})

// Trust proxy
app.set('trust proxy', 1);

// SECURITY
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
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
  'http://localhost:8081',
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

// RATE LIMITERS
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
app.use(
  '/api-docs',
  basicAuth({
    users: { [process.env.SWAGGER_USER!]: process.env.SWAGGER_PASSWORD! },
    challenge: true,
    realm: 'swagger-only',
  }),
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec)
);

// ROUTES
app.use('/api/auth/csrf', authRoutes)
app.use('/api/auth', authRoutes);
app.use('/api/booking', clientRoutes);
app.use('/api/route-optimization', routeOptimizationRoutes);
app.use('/api/directions', directionsRouter);
app.use('/api/driver', driverRoutes)
app.use('/api/admin', adminRoutes);
app.use('/api/uploads', uploadRoutes);

// HEALTH CHECK
app.get('/api/health', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    serverTime: Date.now(),
    environment: process.env.NODE_ENV,
  });
});

app.get('/', (req: Request, res: Response) => {
  res.json({ status: 'OK', message: 'Logistics Backend API is running...' });
});

// 404
app.use((req: Request, res: Response) => {
  res.status(404).json({ status: 'error', message: 'Route not found' });
});

// GLOBAL ERROR HANDLER
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('GLOBAL ERROR:', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  res.status(500).json({
    status: 'error',
    message: IS_PRODUCTION ? 'Internal server error' : err.message,
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Allowed origins:`, allowedOrigins);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

export default app;