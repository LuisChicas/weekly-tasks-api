// Feature flag evaluation helpers — shared by flags route and getUserState
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME } from './dynamodb.js';

type FlagValue = string | boolean | number;

// Queries all enabled flag definitions and returns their default values
export async function getDefaultFlags(): Promise<Record<string, FlagValue>> {
  const result = await docClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': 'FLAGS' },
  }));

  const flags: Record<string, FlagValue> = {};
  for (const item of result.Items || []) {
    if (!item.enabled) continue;
    flags[item.flagName as string] = item.defaultValue as FlagValue;
  }
  return flags;
}

// Evaluates flags for a user: merges defaults with per-user overrides (from FLAG# items)
export function evaluateFlags(
  defaults: Record<string, FlagValue>,
  userFlagItems: Record<string, unknown>[],
): Record<string, FlagValue> {
  const flags = { ...defaults };
  for (const item of userFlagItems) {
    const flagName = (item.SK as string).replace('FLAG#', '');
    if (flagName in flags) {
      flags[flagName] = item.value as FlagValue;
    }
  }
  return flags;
}
