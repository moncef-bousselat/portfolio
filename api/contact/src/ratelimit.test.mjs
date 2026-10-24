import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dynamoLimiter, ipBucket, limitKey, memoryLimiter } from './ratelimit.ts';

describe('ipBucket', () => {
  it('keeps an IPv4 address whole', () => {
    assert.equal(ipBucket('203.0.113.9'), '203.0.113.9');
    assert.equal(ipBucket('::ffff:203.0.113.9'), '203.0.113.9');
  });

  it('reduces IPv6 to its /64, however it is written', () => {
    const bucket = '2001:db8:85a3:1::/64';
    for (const ip of [
      '2001:db8:85a3:1::1',
      '2001:0db8:85a3:0001:ffff:ffff:ffff:ffff',
      '2001:DB8:85A3:1:0:0:0:0',
    ]) {
      assert.equal(ipBucket(ip), bucket, ip);
    }
    assert.equal(ipBucket('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(ipBucket('::1'), '0:0:0:0::/64');
  });
});

describe('limitKey', () => {
  it('is stable, depends on the secret, and does not contain the IP', () => {
    const key = limitKey('203.0.113.9', 'secret');
    assert.equal(limitKey('203.0.113.9', 'secret'), key);
    assert.notEqual(limitKey('203.0.113.9', 'other secret'), key);
    assert.notEqual(limitKey('203.0.113.10', 'secret'), key);
    assert.equal(key.includes('203'), false);
    assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  });

  it('gives one key to a whole IPv6 /64', () => {
    assert.equal(limitKey('2001:db8::1', 's'), limitKey('2001:db8::ffff', 's'));
  });
});

describe('memoryLimiter', () => {
  it('claims once per window and can be released', async () => {
    const limiter = memoryLimiter(60);
    const t0 = new Date('2026-10-21T00:00:00Z');
    assert.equal(await limiter.claim('k', t0), true);
    assert.equal(await limiter.claim('k', new Date(t0.getTime() + 59_000)), false);
    await limiter.release('k');
    assert.equal(await limiter.claim('k', t0), true);
  });
});

describe('dynamoLimiter', () => {
  const now = new Date('2026-10-21T00:00:00Z');
  const seconds = Math.floor(now.getTime() / 1000);

  it('claims with a conditional put that also accepts an expired item', async () => {
    const sent = [];
    const limiter = dynamoLimiter({
      table: 'limits',
      windowSeconds: 300,
      client: { send: async (command) => sent.push(command.input) },
    });
    assert.equal(await limiter.claim('k', now), true);
    assert.deepEqual(sent[0], {
      TableName: 'limits',
      Item: { pk: { S: 'k' }, expiresAt: { N: String(seconds + 300) } },
      ConditionExpression: 'attribute_not_exists(pk) OR expiresAt <= :now',
      ExpressionAttributeValues: { ':now': { N: String(seconds) } },
    });
  });

  it('reports a failed condition as a taken slot, and rethrows anything else', async () => {
    const failing = (error) =>
      dynamoLimiter({
        table: 'limits',
        windowSeconds: 300,
        client: { send: async () => Promise.reject(error) },
      });
    const taken = Object.assign(new Error('taken'), { name: 'ConditionalCheckFailedException' });
    assert.equal(await failing(taken).claim('k', now), false);
    await assert.rejects(failing(new Error('throttled')).claim('k', now), /throttled/);
  });

  it('releases by deleting the item', async () => {
    const sent = [];
    const limiter = dynamoLimiter({
      table: 'limits',
      windowSeconds: 300,
      client: { send: async (command) => sent.push(command.input) },
    });
    await limiter.release('k');
    assert.deepEqual(sent[0], { TableName: 'limits', Key: { pk: { S: 'k' } } });
  });
});
