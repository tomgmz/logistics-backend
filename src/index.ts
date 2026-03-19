import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from "express-rate-limit";
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';
import basicAuth from 'express-basic-auth'
import { swaggerSpec } from './swagger/swagger.config.js';
import adminRoutes from './routes/admin.route.js'
import clientRoutes from './routes/client.routes.js'
import routeOptimizationRoutes from './routes/routeOptimization.route.js'

dotenv.config();

const app = express();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);
app.use(helmet({contentSecurityPolicy: false}));
app.use(
  cors({
    origin: ["http://localhost:3000", "https://logistics-frontend-seven.vercel.app"],
    credentials: true,
    exposedHeaders: ["x-access-token"],
  })
);

app.use(cookieParser(process.env.COOKIE_SECRET));
app.use(express.json());
app.use(morgan('dev'));
app.use(express.urlencoded({ extended: true }));

//swagger with basic auth protection
app.use('/api-docs', basicAuth({
  users: {
    [process.env.SWAGGER_USER!]: process.env.SWAGGER_PASSWORD!
  },
  challenge: true,
}), swaggerUi.serve, swaggerUi.setup(swaggerSpec))

//routes
app.use('/api', adminRoutes)
app.use('/api/booking', clientRoutes)
app.use('/api/route-optimization', routeOptimizationRoutes)

app.get("/", (req: Request, res: Response) => {
  res.json({ status: "OK", message: "Logistics Backend API is running..." });
});

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`Backend is running at http://localhost:${PORT}`);
});