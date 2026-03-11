// Feature flags route — returns default flags for anonymous users
// Authenticated users get flags via login/register/sync responses instead.
import { Router, Response } from 'express';
import { getDefaultFlags } from '../lib/flags.js';

const router = Router();

// Returns enabled flags with default values (no user-specific overrides)
router.get('/', async (_req, res: Response) => {
  try {
    const flags = await getDefaultFlags();
    res.json({ flags });
  } catch (err) {
    console.error('Flags get error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as flagsRouter };
