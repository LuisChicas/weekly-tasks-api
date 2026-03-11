// JWT authentication middleware and token utilities
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

// Decoded JWT payload shape
export interface AuthUser {
  userId: string;
  username: string;
}

// Express Request extended with the authenticated user
export interface AuthRequest extends Request {
  user?: AuthUser;
}

// Verifies Bearer token and attaches user to req.user
export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as AuthUser;
    req.user = { userId: payload.userId, username: payload.username };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Creates a signed JWT with userId and username, valid for 7 days
export function signToken(user: AuthUser): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: '7d' });
}