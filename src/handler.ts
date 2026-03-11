// Lambda entry point — wraps the Express app for AWS Lambda invocation
import serverless from 'serverless-http';
import { app } from './app.js';

export const handler = serverless(app);
