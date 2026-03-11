// Express app setup — CORS, JSON parsing, and route mounting
import express from 'express';
import cors from 'cors';
import { authRouter } from './routes/auth.js';
import { syncRouter } from './routes/sync.js';

export const app = express();

app.use(cors());
app.use(express.json());

// Health check for monitoring and deployment verification
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/auth', authRouter);
app.use('/sync', syncRouter);
