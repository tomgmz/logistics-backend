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
import { authenticate, verifyCsrfToken } from './middlewares/auth.middleware.js';
import { moduleGuard } from './middlewares/moduleAccess.middleware.js';
import clientRoutes from './routes/client.routes.js';
import routeOptimizationRoutes from './routes/routeOptimization.route.js';
import authRoutes from './routes/auth.route.js';
import directionsRouter from './routes/directions.routes.js'
import driverRoutes from './routes/driver.route.js'
import uploadRoutes from './routes/upload.route.js'
import { globalLimiter } from './middlewares/rateLimit.middleware.js';
import messagingRoutes from './routes/messaging.routes.js'
import notificationsRoutes from './routes/notifications.routes.js'
import transactionHistoryRoutes from './routes/transaction-history.routes.js'
import lockRoutes from './routes/locks.routes.js'
import { startFleetRecheckScheduler } from './services/notification/fleet-recheck.scheduler.js'
import { startLocationPruneScheduler } from './services/driver/tracking.service.js'
import { reportEmailLinkBaseUrl } from './lib/brevo-mailer.js'
import { reportWebauthnConfig } from './lib/webauthn-config.js'
import { requestContext } from './lib/request-context.js'
import { logSystem } from './lib/log-system.js'

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
// app.use(globalLimiter);

// MIDDLEWARE
app.use(cookieParser(process.env.COOKIE_SECRET));

// Opens the per-request store the loggers read from (request id, path,
// method, and the user id once authenticate() resolves it). Carries no IP or
// other network identifier — see lib/request-context.ts.
app.use(requestContext);
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

// CSRF, at last actually enforced. `verifyCsrfToken` had been written and
// exported months ago and mounted precisely nowhere, so the web app's careful
// token dance protected nothing. It is mounted here, ahead of everything that
// writes, rather than route by route where the next new route would forget it.
//
// /api/auth is excluded: login and the token endpoint are how a session — and
// its CSRF cookie — come into existence in the first place. The middleware also
// waves through Bearer-authenticated callers (the driver app) and all safe
// methods, so this only ever applies to a cookie-carrying browser write.
app.use('/api/auth/csrf', authRoutes)
app.use('/api/auth', authRoutes);

app.use('/api', verifyCsrfToken);

app.use('/api/booking', clientRoutes);
app.use('/api/route-optimization', routeOptimizationRoutes);
app.use('/api/directions', directionsRouter);
app.use('/api/driver', driverRoutes)
app.use('/api/admin', authenticate, moduleGuard, adminRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/messaging', messagingRoutes);
app.use('/api/notifications', notificationsRoutes);

// Record locks: who is editing what, so two staff never edit one record at once.
// The write guard on each mutating route is the real gate — see lib/record-lock.
app.use('/api/locks', lockRoutes);

// Staff transaction history. Separate from /api/booking so it answers to the
// transaction-history module rather than booking-management.
app.use('/api/transaction-history', transactionHistoryRoutes);

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
// Every unhandled throw in the app lands here. It used to console.error and
// nothing else, so on Render the entire crash history vanished at the next
// restart and the IT Admin had no way to see that anything had failed. It now
// also lands in system_logs, which is what makes that page show anything.
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('GLOBAL ERROR:', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  logSystem({
    log_level:  'error',
    event_type: 'server_error',
    source:     'global-error-handler',
    message:    err.message || 'Unhandled error',
    metadata:   { stack: err.stack, name: err.name },
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
  reportEmailLinkBaseUrl();
  reportWebauthnConfig();

  // Reminds the fleet manager to re-run BLOWBAGETS the day before a booking
  // dispatches and again on the day itself.
  startFleetRecheckScheduler();

  // Drops driver position breadcrumbs past their retention window. The live
  // position table is one row per driver and never needs pruning; the history
  // behind it grows with every ping.
  startLocationPruneScheduler();
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

export default app;