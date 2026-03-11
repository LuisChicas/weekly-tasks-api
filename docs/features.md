# Weekly Tasks API

## Summary

RESTful API backend for the Weekly Tasks application. Custom auth with username/password and JWT tokens. Bulk sync approach minimizes Lambda invocations (~2 per session).

## Endpoints

### Auth (no token required)

#### `POST /auth/register`

Creates a new user account. Accepts existing localStorage data to migrate on signup.

**Body**:
- `username` (string, 3+ chars) — required
- `password` (string, 6+ chars) — required
- `coins` (number) — optional, default 0
- `activeLists` (array) — optional, existing lists to migrate
- `completedLists` (array) — optional

**Response**: `{ token, coins, activeLists, completedLists, flags }`

#### `POST /auth/login`

Authenticates a user and returns their full state.

**Body**: `{ username, password }`

**Response**: `{ token, coins, activeLists, completedLists, flags }`

### Sync (token required)

#### `GET /sync`

Returns the user's full state (includes evaluated feature flags).

**Response**: `{ coins, activeLists, completedLists, flags }`

#### `PUT /sync`

Replaces the user's full state. Handles owned and shared lists separately:

- **Owned lists**: Batch upserts new/updated lists, deletes removed lists, updates coins, diffs `sharedWith` to create/delete `SHARED#` pointers for recipients
- **Shared lists** (`isShared: true`): Writes task updates to the owner's partition with an `updatedAt` guard; handles completion fanout (awards coins, creates `COMPLETED#` items, removes `SHARED#` pointers for all recipients)

**Body**: `{ coins, activeLists, completedLists }`

**Response**: `{ success: true }`

### Health

#### `GET /health`

**Response**: `{ status: "ok" }`

## Auth

- Username + password, no external auth service
- Passwords hashed with bcrypt (10 rounds)
- JWT token with 7-day expiry
- Token sent via `Authorization: Bearer <token>` header

## Data Model

### Task List

```json
{
  "id": "1704067200000",
  "title": "Weekly Goals",
  "deadline": "2025-01-15",
  "items": [...],
  "ownerId": "USER#<uuid>",        // present on owned and shared lists
  "ownerUsername": "alice",        // present on shared lists (recipient view)
  "sharedWith": ["bob", "carol"],  // present on owned lists with sharing
  "isOwner": true,                 // false for recipients
  "isShared": false,               // true for lists shared with the user
  "updatedAt": 1704067200000       // used for conflict resolution on shared edits
}
```

## Sync Strategy

- Frontend works with local state (as it does today with localStorage)
- Manual sync button triggers `PUT /sync` to push state to API
- On load, `GET /sync` (or login response) provides full state
- Typical session: 1 call to load, 1 call to save = 2 Lambda invocations

## Feature Flags

Server-side feature flag system with per-user targeting. Flags are evaluated on every auth/sync response so the frontend always has the latest values.

### Schema

- **Flag definitions** (`PK=FLAGS, SK=FLAG#<name>`): global config with `flagType` (string/boolean/number), `defaultValue`, `enabled`, and `description`
- **Per-user overrides** (`PK=USER#<uuid>, SK=FLAG#<name>`): override `value` for a specific user

### Evaluation

For each enabled flag definition: if the user has a `FLAG#<name>` override, use it; otherwise use `defaultValue`. Evaluated in `getUserState()` alongside user data (parallel DynamoDB queries, no extra latency).

### Current Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `custom_bg_color` | string | `""` (no custom color) | CSS color value applied as page background |

## TBD

- Shared lists (in progress — see `docs/features.sharedLists.md`)