import { createHmac } from 'node:crypto';

export function signQuery(queryString: string, secret: string): string {
  return createHmac('sha256', secret).update(queryString).digest('hex');
}
