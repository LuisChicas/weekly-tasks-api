// Auth routes — registration and login with bcrypt password hashing
import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { QueryCommand, GetCommand, PutCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME } from '../lib/dynamodb.js';
import { signToken } from '../middleware/auth.js';
import { getDefaultFlags, evaluateFlags } from '../lib/flags.js';

const router = Router();

// Shape of a task list as stored in DynamoDB
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
  updatedAt?: string;
}

// Helper: write lists to DynamoDB. Active lists use conditional writes to preserve newer recipient
// edits; completed lists are batched with no guard (no sharing semantics apply).
async function batchWriteLists(
  userId: string,
  activeLists: ListItem[],
  completedLists: ListItem[]
): Promise<void> {
  // Write each active list individually with an updatedAt guard so a stale owner sync cannot
  // overwrite a more recent edit that a recipient already wrote to the owner's partition.
  for (const list of activeLists.filter(l => !l.isShared)) {
    const incomingUpdatedAt = list.updatedAt || new Date().toISOString();
    try {
      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `USER#${userId}`,
          SK: `LIST#${list.id}`,
          title: list.title,
          deadline: list.deadline,
          items: list.items,
          ...(list.ownerId !== undefined && { ownerId: list.ownerId }),
          ...(list.sharedWith !== undefined && { sharedWith: list.sharedWith }),
          updatedAt: incomingUpdatedAt,
        },
        // Only write if the server has no timestamp yet, or ours is at least as recent
        ConditionExpression: 'attribute_not_exists(updatedAt) OR updatedAt <= :incomingAt',
        ExpressionAttributeValues: { ':incomingAt': incomingUpdatedAt },
      }));
    } catch (err: unknown) {
      // ConditionalCheckFailedException means the server has a newer version (e.g. a recipient
      // edit arrived after the owner loaded their state) — safe to skip, response will return fresh state
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    }
  }

  // Completed lists have no sharing semantics — batch write as before
  const completedRequests = completedLists.map(list => ({
    PutRequest: {
      Item: {
        PK: `USER#${userId}`,
        SK: `COMPLETED#${list.id}`,
        title: list.title,
        deadline: list.deadline,
        items: list.items,
      },
    },
  }));

  // DynamoDB BatchWrite limit is 25 items per request
  for (let i = 0; i < completedRequests.length; i += 25) {
    const batch = completedRequests.slice(i, i + 25);
    await docClient.send(new BatchWriteCommand({
      RequestItems: { [TABLE_NAME]: batch },
    }));
  }
}

// Queries all items under USER#<id> and groups them into coins, lists, and flags
async function getUserState(userId: string) {
  // Fetch user data and global flag definitions in parallel
  const [userResult, defaultFlags] = await Promise.all([
    docClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `USER#${userId}` },
    })),
    getDefaultFlags(),
  ]);

  let coins = 0;
  const activeLists: ListItem[] = [];
  const completedLists: ListItem[] = [];
  const userFlagItems: Record<string, unknown>[] = [];
  const sharedPointers: Array<{ ownerUserId: string; ownerUsername: string; listId: string }> = [];

  for (const item of userResult.Items || []) {
    const sk = item.SK as string;
    if (sk === 'PROFILE') {
      coins = (item.coins as number) || 0;
    } else if (sk.startsWith('LIST#')) {
      activeLists.push({
        id: sk.replace('LIST#', ''),
        title: item.title as string,
        deadline: item.deadline as string,
        items: item.items as unknown[],
        ownerId: item.ownerId as string | undefined,
        sharedWith: item.sharedWith as string[] | undefined,
        updatedAt: item.updatedAt as string | undefined,
        isOwner: true,
      });
    } else if (sk.startsWith('COMPLETED#')) {
      completedLists.push({
        id: sk.replace('COMPLETED#', ''),
        title: item.title as string,
        deadline: item.deadline as string,
        items: item.items as unknown[],
      });
    } else if (sk.startsWith('SHARED#')) {
      sharedPointers.push({
        ownerUserId: item.ownerUserId as string,
        ownerUsername: item.ownerUsername as string,
        listId: item.listId as string,
      });
    } else if (sk.startsWith('FLAG#')) {
      userFlagItems.push(item);
    }
  }

  // Resolve SHARED# pointers: fetch each actual list from the owner's partition
  if (sharedPointers.length > 0) {
    const sharedLists = await Promise.all(
      sharedPointers.map(async (pointer) => {
        const result = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { PK: `USER#${pointer.ownerUserId}`, SK: `LIST#${pointer.listId}` },
        }));
        if (!result.Item) return null;
        const item = result.Item;
        return {
          id: pointer.listId,
          title: item.title as string,
          deadline: item.deadline as string,
          items: item.items as unknown[],
          ownerId: pointer.ownerUserId,
          ownerUsername: pointer.ownerUsername,
          sharedWith: item.sharedWith as string[] | undefined,
          updatedAt: item.updatedAt as string | undefined,
          isShared: true,
          isOwner: false,
        } as ListItem;
      })
    );
    for (const list of sharedLists) {
      if (list) activeLists.push(list);
    }
  }

  // Merge global defaults with user-specific overrides
  const flags = evaluateFlags(defaultFlags, userFlagItems);

  return { coins, activeLists, completedLists, flags };
}

// Creates a new user with hashed password, migrates any existing localStorage data
router.post('/register', async (req, res: Response) => {
  try {
    const { username, password, coins, activeLists, completedLists } = req.body;

    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }

    if (username.length < 3 || password.length < 6) {
      res.status(400).json({ error: 'Username must be 3+ chars, password 6+ chars' });
      return;
    }

    // Check username uniqueness via GSI
    const existing = await docClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'UsernameIndex',
      KeyConditionExpression: 'username = :u',
      ExpressionAttributeValues: { ':u': username },
      Limit: 1,
    }));

    if (existing.Items && existing.Items.length > 0) {
      res.status(409).json({ error: 'Username already taken' });
      return;
    }

    const userId = uuidv4();
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user profile
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `USER#${userId}`,
        SK: 'PROFILE',
        username,
        passwordHash,
        coins: coins || 0,
        createdAt: new Date().toISOString(),
      },
    }));

    // Write any existing lists from localStorage
    if ((activeLists?.length || 0) > 0 || (completedLists?.length || 0) > 0) {
      await batchWriteLists(userId, activeLists || [], completedLists || []);
    }

    const token = signToken({ userId, username });
    const state = await getUserState(userId);

    res.status(201).json({ token, ...state });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Authenticates user by username (via GSI) and password, returns JWT + full state
router.post('/login', async (req, res: Response) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }

    // Look up user by username via GSI
    const result = await docClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'UsernameIndex',
      KeyConditionExpression: 'username = :u',
      ExpressionAttributeValues: { ':u': username },
      Limit: 1,
    }));

    if (!result.Items || result.Items.length === 0) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    const userItem = result.Items[0];
    const valid = await bcrypt.compare(password, userItem.passwordHash as string);
    if (!valid) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    const userId = (userItem.PK as string).replace('USER#', '');
    const token = signToken({ userId, username });
    const state = await getUserState(userId);

    res.json({ token, ...state });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as authRouter, getUserState, batchWriteLists };