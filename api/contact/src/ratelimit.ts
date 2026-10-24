/**
 * One message per visitor per window (5 minutes by default).
 *
 * The handler claims a slot only once Turnstile has passed, so nobody can
 * lock a shared IP out without solving the challenge, and gives it back if
 * the email then fails to send.
 *
 * The key is never the IP itself: it is an HMAC of the IP under a key
 * derived from the Turnstile secret, so the table holds nothing that names
 * a visitor, and an IPv4 address (2^32 of them) cannot be recovered by
 * hashing every candidate. DynamoDB's TTL deletes expired items lazily,
 * sometimes days later, which is why the key matters and why the claim
 * compares expiry times itself rather than trusting an item's absence.
 *
 * IPv6 visitors are grouped by /64: one connection usually holds a whole
 * /64, so a per-address limit could be dodged by changing the last bits.
 */
import { createHmac } from 'node:crypto';
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';

export interface RateLimiter {
  /** Takes the visitor's slot. False when the window is still running. */
  claim(key: string, now: Date): Promise<boolean>;
  /** Frees the slot again, for a message that could not be sent. */
  release(key: string): Promise<void>;
  windowSeconds: number;
}

/**
 * The part of an address that identifies one visitor: an IPv4 address as
 * is, an IPv6 address by its /64 prefix, written in full.
 */
export function ipBucket(ip: string): string {
  if (!ip.includes(':')) return ip;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1]) return mapped[1];

  const [head, tail] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return `${groups
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(':')}::/64`;
}

/** The table key for a visitor: HMAC(derived key, IP bucket). */
export function limitKey(ip: string, secret: string): string {
  const key = createHmac('sha256', secret).update('portfolio-contact/rate-limit/v1').digest();
  return createHmac('sha256', key).update(ipBucket(ip)).digest('base64url');
}

/** For local development: one process, so a Map is the whole store. */
export function memoryLimiter(windowSeconds: number): RateLimiter {
  const until = new Map<string, number>();
  return {
    windowSeconds,
    async claim(key, now) {
      const at = now.getTime();
      if ((until.get(key) ?? 0) > at) return false;
      until.set(key, at + windowSeconds * 1000);
      return true;
    },
    async release(key) {
      until.delete(key);
    },
  };
}

export interface DynamoLimiterOptions {
  table: string;
  windowSeconds: number;
  client?: Pick<DynamoDBClient, 'send'>;
}

/**
 * A conditional put: it succeeds when no item exists for the key or the
 * existing one has expired, and fails atomically otherwise, so two
 * simultaneous requests cannot both pass.
 */
export function dynamoLimiter(options: DynamoLimiterOptions): RateLimiter {
  const { table, windowSeconds } = options;
  let client = options.client;
  const db = () => (client ??= new DynamoDBClient({}));

  return {
    windowSeconds,
    async claim(key, now) {
      const nowSeconds = Math.floor(now.getTime() / 1000);
      try {
        await db().send(
          new PutItemCommand({
            TableName: table,
            Item: { pk: { S: key }, expiresAt: { N: String(nowSeconds + windowSeconds) } },
            ConditionExpression: 'attribute_not_exists(pk) OR expiresAt <= :now',
            ExpressionAttributeValues: { ':now': { N: String(nowSeconds) } },
          }),
        );
        return true;
      } catch (error) {
        if (
          error instanceof ConditionalCheckFailedException ||
          (error as Error | undefined)?.name === 'ConditionalCheckFailedException'
        ) {
          return false;
        }
        throw error;
      }
    },
    async release(key) {
      await db().send(new DeleteItemCommand({ TableName: table, Key: { pk: { S: key } } }));
    },
  };
}
