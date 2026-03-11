// DynamoDB client singleton — uses local endpoint in dev, IAM credentials in prod
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { fromIni } from '@aws-sdk/credential-providers';

const dynamoEndpoint = process.env.DYNAMODB_ENDPOINT;
const awsProfile = process.env.AWS_PROFILE;

const client = new DynamoDBClient({
  ...(dynamoEndpoint && { endpoint: dynamoEndpoint }),
  ...(awsProfile && { credentials: fromIni({ profile: awsProfile }) }),
});
export const docClient = DynamoDBDocumentClient.from(client);

// Table name is set per stage via serverless.yml (e.g. weekly-tasks-api-dev)
export const TABLE_NAME = process.env.TABLE_NAME!;