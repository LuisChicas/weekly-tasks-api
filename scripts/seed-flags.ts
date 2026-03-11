// Seeds feature flag definitions and optional per-user overrides into DynamoDB.
// Usage:
//   npx tsx scripts/seed-flags.ts                              — seed flag definitions only
//   npx tsx scripts/seed-flags.ts <username> <color>           — also set custom_bg_color for a user
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME } from '../src/lib/dynamodb.js';

async function seedFlags() {
  // Create the custom_bg_color flag definition
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: 'FLAGS',
      SK: 'FLAG#custom_bg_color',
      flagName: 'custom_bg_color',
      flagType: 'string',
      defaultValue: '',
      enabled: true,
      description: 'Custom page background color (CSS color value)',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  }));

  console.log('Seeded flag definition: custom_bg_color');

  // Optionally set a per-user override by username
  const targetUsername = process.argv[2];
  const color = process.argv[3] || '#e8f4f8';

  if (targetUsername) {
    // Look up userId via UsernameIndex GSI
    const result = await docClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'UsernameIndex',
      KeyConditionExpression: 'username = :u',
      ExpressionAttributeValues: { ':u': targetUsername },
      Limit: 1,
    }));

    if (!result.Items || result.Items.length === 0) {
      console.error(`User "${targetUsername}" not found`);
      process.exit(1);
    }

    const userId = (result.Items[0].PK as string).replace('USER#', '');

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `USER#${userId}`,
        SK: 'FLAG#custom_bg_color',
        flagName: 'custom_bg_color',
        value: color,
        updatedAt: new Date().toISOString(),
      },
    }));
    console.log(`Set custom_bg_color = "${color}" for user "${targetUsername}" (${userId})`);
  }
}

seedFlags().catch(console.error);
