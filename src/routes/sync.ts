// Sync routes — bulk read/write of user state (requires auth)
import { Router, Response } from 'express';
import { QueryCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME } from '../lib/dynamodb.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import { getUserState, batchWriteLists } from './auth.js';

const router = Router();

router.use(authMiddleware);

// Returns coins, active lists, and completed lists for the authenticated user
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const state = await getUserState(req.user!.userId);
    res.json(state);
  } catch (err) {
    console.error('Sync get error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Looks up a userId by username via GSI
async function lookupUserId(username: string): Promise<string | null> {
  const result = await docClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'UsernameIndex',
    KeyConditionExpression: 'username = :u',
    ExpressionAttributeValues: { ':u': username },
    Limit: 1,
  }));
  if (!result.Items || result.Items.length === 0) return null;
  return (result.Items[0].PK as string).replace('USER#', '');
}

// Replaces all user lists and coins — handles owned lists, shared list writes, and completion fanout
router.put('/', async (req: AuthRequest, res: Response) => {
  try {
    const { coins, activeLists = [], completedLists = [] } = req.body;
    const userId = req.user!.userId;
    const username = req.user!.username;

    // Separate owned vs shared active lists
    const ownedActive = activeLists.filter((l: { isShared?: boolean }) => !l.isShared);
    const sharedActive = activeLists.filter((l: { isShared?: boolean }) => l.isShared);

    // Get existing items under the user's partition
    const existing = await docClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `USER#${userId}` },
      ProjectionExpression: 'SK',
    }));

    const existingSKs = new Set(
      (existing.Items || [])
        .map(item => item.SK as string)
        .filter(sk => sk.startsWith('LIST#') || sk.startsWith('COMPLETED#'))
    );

    // Build set of incoming owned SKs (shared lists live in owner's partition, not here)
    const incomingSKs = new Set<string>();
    for (const list of ownedActive) {
      incomingSKs.add(`LIST#${list.id}`);
    }
    for (const list of completedLists) {
      incomingSKs.add(`COMPLETED#${list.id}`);
    }

    // Delete owned items that are no longer present
    const toDelete = [...existingSKs].filter(sk => !incomingSKs.has(sk));
    if (toDelete.length > 0) {
      for (let i = 0; i < toDelete.length; i += 25) {
        const batch = toDelete.slice(i, i + 25).map(sk => ({
          DeleteRequest: { Key: { PK: `USER#${userId}`, SK: sk } },
        }));
        await docClient.send(new BatchWriteCommand({
          RequestItems: { [TABLE_NAME]: batch },
        }));
      }
    }

    // Handle newly completed shared lists (owner just completed them)
    // "Newly completed" = has sharedWith, isOwner is not false, and wasn't already COMPLETED# in DB
    interface ListBody {
      id: string;
      title: string;
      deadline?: string;
      items?: unknown[];
      sharedWith?: string[];
      isOwner?: boolean;
      isShared?: boolean;
      ownerId?: string;
      updatedAt?: string;
    }
    const newlyCompletedShared = (completedLists as ListBody[]).filter(l =>
      l.sharedWith && l.sharedWith.length > 0 &&
      l.isOwner !== false &&
      !existingSKs.has(`COMPLETED#${l.id}`)
    );

    for (const list of newlyCompletedShared) {
      let earned = 0;
      if (list.deadline) {
        const deadline = new Date(list.deadline);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        deadline.setHours(0, 0, 0, 0);
        const daysEarly = Math.floor((deadline.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        if (daysEarly >= 0) earned = 1 + daysEarly;
      }

      await Promise.all((list.sharedWith || []).map(async (sharedUsername: string) => {
        const recipientId = await lookupUserId(sharedUsername);
        if (!recipientId) return;
        await Promise.all([
          // Award coins
          docClient.send(new UpdateCommand({
            TableName: TABLE_NAME,
            Key: { PK: `USER#${recipientId}`, SK: 'PROFILE' },
            UpdateExpression: 'ADD coins :c',
            ExpressionAttributeValues: { ':c': earned },
          })),
          // Create COMPLETED# item for shared user
          docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: {
              PK: `USER#${recipientId}`,
              SK: `COMPLETED#${list.id}`,
              title: list.title,
              deadline: list.deadline || '',
              items: list.items || [],
            },
          })),
          // Remove SHARED# pointer
          docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { PK: `USER#${recipientId}`, SK: `SHARED#${list.id}` },
          })),
        ]);
      }));
    }

    // Handle SHARED# pointer diffing for owned lists whose sharedWith changed
    const listsWithSharing = (ownedActive as ListBody[]).filter(l => l.sharedWith !== undefined);
    for (const list of listsWithSharing) {
      const stored = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `USER#${userId}`, SK: `LIST#${list.id}` },
      }));
      const oldSharedWith: string[] = (stored.Item?.sharedWith as string[]) || [];
      const newSharedWith: string[] = list.sharedWith || [];

      const added = newSharedWith.filter(u => !oldSharedWith.includes(u));
      const removed = oldSharedWith.filter(u => !newSharedWith.includes(u));

      await Promise.all([
        ...added.map(async (addedUsername: string) => {
          const recipientId = await lookupUserId(addedUsername);
          if (!recipientId) return;
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: {
              PK: `USER#${recipientId}`,
              SK: `SHARED#${list.id}`,
              ownerUserId: userId,
              ownerUsername: username,
              listId: list.id,
            },
          }));
        }),
        ...removed.map(async (removedUsername: string) => {
          const recipientId = await lookupUserId(removedUsername);
          if (!recipientId) return;
          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { PK: `USER#${recipientId}`, SK: `SHARED#${list.id}` },
          }));
        }),
      ]);
    }

    // Handle shared list writes from non-owners: write to owner's partition
    for (const list of (sharedActive as ListBody[])) {
      if (!list.ownerId) continue;
      const stored = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `USER#${list.ownerId}`, SK: `LIST#${list.id}` },
      }));
      // Only update if incoming updatedAt is newer (or no timestamp on either side)
      const storedUpdatedAt = stored.Item?.updatedAt as string | undefined;
      const incomingUpdatedAt = list.updatedAt;
      if (!storedUpdatedAt || !incomingUpdatedAt || incomingUpdatedAt >= storedUpdatedAt) {
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            PK: `USER#${list.ownerId}`,
            SK: `LIST#${list.id}`,
            title: list.title,
            deadline: list.deadline || '',
            items: list.items || [],
            ownerId: list.ownerId,
            // Preserve sharedWith from server — only owner can change who the list is shared with
            sharedWith: stored.Item?.sharedWith,
            updatedAt: incomingUpdatedAt || new Date().toISOString(),
          },
        }));
      }
    }

    // Write all owned lists and coins
    await batchWriteLists(userId, ownedActive, completedLists);

    if (typeof coins === 'number') {
      await docClient.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `USER#${userId}`, SK: 'PROFILE' },
        UpdateExpression: 'SET coins = :c',
        ExpressionAttributeValues: { ':c': coins },
      }));
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Sync put error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as syncRouter };