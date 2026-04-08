# Technical Documentation - Weekly Tasks API

## Technical Stack

- **Node.js 20** — runtime
- **TypeScript** — type-safe JavaScript
- **Express** — HTTP framework
- **serverless-http** — wraps Express for AWS Lambda
- **Serverless Framework v3** — infrastructure as code and deployment
- **AWS SDK v3** — DynamoDB client (`@aws-sdk/lib-dynamodb`, `@aws-sdk/credential-providers`)
- **esbuild** — bundling for Lambda (via serverless-esbuild)
- **bcryptjs** — password hashing
- **jsonwebtoken** — JWT creation and verification
- **uuid** — user ID generation

## Project Structure

```
weekly-tasks-api/
├── docs/
│   ├── features.md         # Product features and API contract
│   └── tech.md             # Architecture, infrastructure, data model
├── scripts/
│   └── seed-flags.ts           # Seeds flag definitions + per-user overrides
├── src/
│   ├── handler.ts              # Lambda entry point (wraps Express)
│   ├── app.ts                  # Express app, mounts routes
│   ├── middleware/
│   │   └── auth.ts             # JWT verification middleware + signToken helper
│   ├── routes/
│   │   ├── auth.ts             # POST /auth/register, POST /auth/login
│   │   └── sync.ts             # GET /sync, PUT /sync (auth required)
│   └── lib/
│       ├── dynamodb.ts         # DynamoDB DocumentClient singleton
│       └── flags.ts            # Flag evaluation helpers (getDefaultFlags, evaluateFlags)
├── serverless.yml
├── tsconfig.json
├── package.json
├── .env.development            # Local dev config (gitignored)
├── .env.production             # Prod deploy config (gitignored)
└── .gitignore
```

## DynamoDB

### Table Design

Single-table design: `weekly-tasks-api-{stage}`

| Entity | PK | SK | Key Attributes |
|---|---|---|---|
| User | `USER#<uuid>` | `PROFILE` | username, passwordHash, coins, createdAt |
| Active list | `USER#<uuid>` | `LIST#<listId>` | title, deadline, items, ownerId, sharedWith, updatedAt (always set by server on write) |
| Completed list | `USER#<uuid>` | `COMPLETED#<listId>` | title, deadline, items |
| Shared list pointer | `USER#<recipientId>` | `SHARED#<listId>` | ownerId, ownerUsername |
| Flag definition | `FLAGS` | `FLAG#<flagName>` | flagName, flagType, defaultValue, enabled, description |
| User flag override | `USER#<uuid>` | `FLAG#<flagName>` | flagName, value |

### GSI

**UsernameIndex** — PK: `username`, Projection: ALL. Used for login lookup (find user by username).

### Billing

PAY_PER_REQUEST (on-demand, scales to zero).

### Shared List Concurrency

- `batchWriteLists()` always writes `updatedAt: new Date().toISOString()` on every owned-list write
- Non-owner (recipient) writes are accepted only when: `!storedUpdatedAt || (incomingUpdatedAt && incomingUpdatedAt >= storedUpdatedAt)`
- This prevents a stale client from overwriting a newer server copy on sync

### Feature Flags Schema

- **Flag definitions**: `PK=FLAGS`, `SK=FLAG#<name>` — global config with `flagType`, `defaultValue`, `enabled`, `description`
- **Per-user overrides**: `PK=USER#<uuid>`, `SK=FLAG#<name>` — stores `value` for a specific user
- Evaluated in `getUserState()` via `evaluateFlags(defaults, userItems)`: user override wins, falls back to `defaultValue` for enabled flags
- Fetched in parallel with user data (no extra latency)

## Infrastructure

| Service | Purpose |
|---|---|
| Lambda | Runs the Express API (single function, all routes) |
| Lambda Function URL | Public HTTPS endpoint (no API Gateway in prod) |
| API Gateway | HTTP API v2, catch-all route (dev only, via serverless-offline) |
| DynamoDB | NoSQL database, on-demand billing |

## Environment Variables

| Variable | Source | Description |
|---|---|---|
| `TABLE_NAME` | serverless.yml | DynamoDB table name |
| `JWT_SECRET` | env / default | Secret for signing JWTs |
| `DYNAMODB_ENDPOINT` | env / empty | Local DynamoDB endpoint (dev only) |
| `AWS_PROFILE` | .env | AWS credentials profile (dev only) |

## Development

### Prerequisites

- Docker (for DynamoDB Local)
- Node.js 20+

### Local Setup

```bash
# Start DynamoDB Local (persistent, from repo root)
cd db && docker compose up -d

# Create table (one-time per volume)
./db/create-local-table.sh

# Install and run
npm install
npm run dev    # Starts on port 3009
```

### .env.development (gitignored)

```
AWS_PROFILE=<your-profile>
DYNAMODB_ENDPOINT=http://localhost:8000
```

### .env.production (gitignored)

```
AWS_PROFILE=<your-profile>
JWT_SECRET=<generated-secret>
```

### Scripts

| Script | Command | Description |
|---|---|---|
| `dev` | `node --env-file=.env.development ... serverless offline` | Local dev server (port 3009) |
| `deploy` | `node --env-file=.env.production ... serverless deploy --stage prod` | Deploy to AWS |
| `typecheck` | `tsc --noEmit` | TypeScript type checking |
| `seed-flags` | `node --env-file=.env.development ... tsx scripts/seed-flags.ts` | Seed flag definitions into DynamoDB |

#### Seed Flags Script

Seeds feature flag definitions and optional per-user overrides into DynamoDB.

```bash
# Seed flag definitions only (local)
npm run seed-flags

# Seed + set a per-user override by username (local)
npm run seed-flags -- <username> <color>

# Run against production (TABLE_NAME not in .env.production, must pass inline)
TABLE_NAME=weekly-tasks-api-prod node --env-file=.env.production node_modules/.bin/tsx scripts/seed-flags.ts <username> <color>
```

### DynamoDB Local Notes

- Runs via Docker on port 8000 (see `db/docker-compose.yml`)
- Data persists across container restarts via a named Docker volume (`weekly-tasks-dynamodb-data`)
- Data is namespaced by AWS access key — must use the same credentials for table creation and app access
- Run `./db/create-local-table.sh` once after creating a fresh volume

## Deployment

```bash
npm run deploy    # Deploys to prod stage via .env.production
```

The deploy script loads `.env.production` (AWS_PROFILE, JWT_SECRET) and runs `serverless deploy --stage prod`. In Lambda, `DYNAMODB_ENDPOINT` is empty so the SDK connects to real DynamoDB, and IAM role credentials are used (not AWS_PROFILE).