# Shared Lists

## Summary

Users can share task lists with other users by username. A shared list appears in the recipient's active lists and can be edited by both parties. The owner controls who the list is shared with.

## Design Decisions

- **Only the owner** can add/remove shared users (unsubscribe may be added later)
- **Only the owner** can complete a shared list
- **All users earn coins** when a shared list is completed (owner + shared users, same formula)
- Shared lists show a **"shared by \<username\>"** label for non-owners
- **Last-write-wins** merge strategy at the list level for V1

---

## DynamoDB Schema Changes

Single-table, no new tables, no new GSIs.

### Modified items

**LIST# items** gain new attributes:

| Attribute | Type | Description |
|---|---|---|
| `ownerId` | string | userId of the creator. Missing = owned by the PK user (backward compat) |
| `sharedWith` | string[] | Usernames the list is shared with. Missing = `[]` |
| `updatedAt` | string (ISO) | Last modified timestamp. Missing = epoch (for merge) |

### New item type

**SHARED# pointer** — stored under the recipient's partition so `getUserState()` discovers it:

| PK | SK | Attributes |
|---|---|---|
| `USER#<recipientId>` | `SHARED#<listId>` | `ownerUserId`, `ownerUsername`, `listId` |

### No migration needed

Missing `ownerId`/`sharedWith`/`updatedAt` handled gracefully in code. Fields written lazily as lists are synced.

---

## API Changes

No per-action endpoints. Sharing, unsharing, and completion all flow through the existing sync endpoints.

### Modify `getUserState()` in `src/routes/auth.ts`

Current loop groups items by SK prefix. Add `SHARED#` handling:

1. Collect SHARED# pointers during the existing loop
2. After the loop, fetch each actual list from owner's partition via `GetCommand` (in parallel with `Promise.all`)
3. Add resolved lists to `activeLists` with `isShared: true`, `isOwner: false`, `ownerId`, `ownerUsername` (from SHARED# pointer), `sharedWith`
4. Mark owned lists with `isOwner: true`

### Modify `batchWriteLists()` in `src/routes/auth.ts`

Include `ownerId`, `sharedWith`, and `updatedAt` when writing LIST# items (if present on the list object).

### Modify `PUT /sync` in `src/routes/sync.ts`

Separate incoming `activeLists` into owned vs shared:

- **Owned lists** (`!isShared`): existing diff/delete/write logic (unchanged)
- **Shared lists** (`isShared`): write to the **owner's** partition, not the syncing user's. For each:
  1. Fetch the current server copy from the owner's partition
  2. Apply merge (compare `updatedAt`; if incoming is newer, accept)
  3. Write back via `PutCommand`
  4. Diff `sharedWith` arrays (old vs new) — added usernames → create `SHARED#` pointers; removed usernames → delete them
- **Completion of a shared list** (list appears in `completedLists` with `isOwner: true` and non-empty `sharedWith`):
  1. Calculate coins earned
  2. Create `COMPLETED#<listId>` under owner's partition
  3. For each shared user: award coins, create their `COMPLETED#<listId>`, delete their `SHARED#<listId>` pointer
- The existing SK filter (`LIST#` and `COMPLETED#`) already skips `SHARED#` pointers in the diff

### Extend `ListItem` interface in `src/routes/auth.ts`

```typescript
interface ListItem {
  id: string;
  title: string;
  deadline: string;
  items: unknown[];
  ownerId?: string;
  ownerUsername?: string;
  sharedWith?: string[];
  isShared?: boolean;
  isOwner?: boolean;
}
```

---

## Frontend Changes

### Extend types: `app/components/TaskPanel/types.ts`

Add to `TaskPanelData`:
```typescript
ownerId?: string;
ownerUsername?: string;    // for "shared by X" label
sharedWith?: string[];
isShared?: boolean;
isOwner?: boolean;
```

### New TaskPanel props

```typescript
isOwner?: boolean;          // defaults to true for non-shared lists
sharedWith?: string[];      // usernames the list is shared with
onShare?: (username: string) => void;
onUnshare?: (username: string) => void;
```

### Shared list indicator

Non-owners see "shared by \<username\>" label below the title.

### Page handlers: `app/page.tsx`

- `handleShare(listId, username)` — updates `sharedWith` locally; next sync propagates to server
- `handleUnshare(listId, username)` — removes from `sharedWith` locally; next sync removes the `SHARED#` pointer server-side
- `handleComplete` — for shared lists, move to `completedLists` locally with `isOwner: true`; next sync handles coin distribution and cleanup
- Pass `isOwner`, `sharedWith`, `onShare`, `onUnshare` to TaskPanel

No new `api.ts` functions needed — everything goes through the existing `pushSync`.

---

## Merge Strategy

### V1: Last-Write-Wins (list level)

When a shared list is updated via PUT /sync:
1. Compare incoming `updatedAt` with stored `updatedAt`
2. If incoming is **newer or equal** → accept the update
3. If incoming is **older** → reject and return the current server version; frontend replaces its local copy

Simple and works because sync is manual — the slower syncer's changes are overwritten, but they consciously clicked "sync".

---

## Files Summary

### API — Modify
| File | Changes |
|---|---|
| `src/routes/auth.ts` | Extend ListItem, modify `getUserState()` for SHARED# pointers, modify `batchWriteLists()` |
| `src/routes/sync.ts` | Handle shared lists in PUT /sync: merge, SHARED# pointer diffing, completion fanout |
| `docs/features.sharedLists.md` | This document |

### Frontend — Modify
| File | Changes | Status |
|---|---|---|
| `app/components/TaskPanel/types.ts` | Add sharing fields to TaskPanelData | pending |
| `app/page.tsx` | Share/unshare local handlers, pass props, shared completion | pending |

---

## Implementation Order

1. Extend `ListItem` (API) and `TaskPanelData` (frontend) types
2. Modify `getUserState()` — resolve SHARED# pointers on read
3. Modify `batchWriteLists()` — persist new attributes
4. Modify `PUT /sync` — merge, SHARED# diffing, shared list completion fanout
5. Add share/unshare local handlers in `page.tsx`, pass props to TaskPanel
6. Add shared list indicator in TaskPanel ("shared by X")
7. Build both projects, test end-to-end
