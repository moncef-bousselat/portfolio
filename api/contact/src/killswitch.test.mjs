import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  composeNotice,
  createKillSwitch,
  disableDistribution,
  killSwitchFromEnv,
} from './killswitch.ts';

const config = {
  CallerReference: 'ref',
  Comment: 'portfolio static site',
  Enabled: true,
  Origins: {},
};

/** A CloudFront client fake that records each command's name and input. */
function cloudfront({ enabled = true, failOn } = {}) {
  const calls = [];
  return {
    calls,
    async send(command) {
      const name = command.constructor.name;
      calls.push({ name, input: command.input });
      if (name === failOn) throw Object.assign(new Error('nope'), { name: 'AccessDenied' });
      if (name === 'GetDistributionConfigCommand') {
        return { ETag: 'E1', DistributionConfig: { ...config, Enabled: enabled } };
      }
      return {};
    },
  };
}

function sns() {
  const published = [];
  return { published, send: async (command) => published.push(command.input) };
}

const alarm = (overrides = {}) => ({
  AlarmName: 'portfolio-kill-switch-5min',
  AlarmDescription: 'Estimated CloudFront cost of at least $0.50 in 5 minutes.',
  NewStateValue: 'ALARM',
  NewStateReason:
    'Threshold Crossed: 1 datapoint [0.73] was greater than or equal to the threshold (0.5).',
  StateChangeTime: '2026-10-24T21:00:00.000+0000',
  Trigger: { Period: 300 },
  ...overrides,
});

const event = (...alarms) => ({
  Records: alarms.map((a) => ({ Sns: { Message: JSON.stringify(a) } })),
});

const deps = (overrides = {}) => ({
  distributionId: 'E2EXAMPLE',
  notifyTopicArn: 'arn:aws:sns:us-east-1:123456789012:portfolio-kill-switch-notify',
  site: 'example.com',
  cloudfront: cloudfront(),
  sns: sns(),
  log: () => {},
  ...overrides,
});

describe('disableDistribution', () => {
  it('sets Enabled=false with the ETag, and keeps the rest of the configuration', async () => {
    const client = cloudfront();
    assert.deepEqual(await disableDistribution(client, 'E2EXAMPLE'), { status: 'disabled' });
    const update = client.calls.find((call) => call.name === 'UpdateDistributionCommand');
    assert.deepEqual(update.input, {
      Id: 'E2EXAMPLE',
      IfMatch: 'E1',
      DistributionConfig: { ...config, Enabled: false },
    });
  });

  it('changes nothing when the distribution is already disabled', async () => {
    const client = cloudfront({ enabled: false });
    assert.deepEqual(await disableDistribution(client, 'E2EXAMPLE'), { status: 'alreadyDisabled' });
    assert.equal(
      client.calls.some((call) => call.name === 'UpdateDistributionCommand'),
      false,
    );
  });

  it('reports a failure instead of throwing', async () => {
    const client = cloudfront({ failOn: 'UpdateDistributionCommand' });
    assert.deepEqual(await disableDistribution(client, 'E2EXAMPLE'), {
      status: 'failed',
      error: 'AccessDenied',
    });
  });
});

describe('kill switch', () => {
  it('disables the site and emails the owner once per alarm', async () => {
    const d = deps();
    await createKillSwitch(d)(event(alarm()));
    assert.equal(
      d.cloudfront.calls.filter((c) => c.name === 'UpdateDistributionCommand').length,
      1,
    );
    assert.equal(d.sns.published.length, 1);
    assert.equal(d.sns.published[0].TopicArn, d.notifyTopicArn);
    assert.equal(d.sns.published[0].Subject, 'example.com is offline: CloudFront cost alarm');
    assert.match(d.sns.published[0].Message, /gh workflow run reopen-site\.yml/);
  });

  it('ignores anything but a transition into ALARM', async () => {
    const d = deps();
    await createKillSwitch(d)(event(alarm({ NewStateValue: 'OK' })));
    assert.equal(d.cloudfront.calls.length, 0);
    assert.equal(d.sns.published.length, 0);
  });

  it('still emails, with the manual fallback, when disabling fails', async () => {
    const d = deps({ cloudfront: cloudfront({ failOn: 'GetDistributionConfigCommand' }) });
    await createKillSwitch(d)(event(alarm()));
    assert.equal(d.sns.published.length, 1);
    assert.match(d.sns.published[0].Subject, /^ACTION NEEDED: .*FAILED$/);
    assert.match(d.sns.published[0].Message, /still online/);
  });

  it('keeps SNS subjects within the 100-character limit', async () => {
    const long = { distributionId: 'E2EXAMPLE', site: 'a-rather-long-subdomain.example.com' };
    for (const outcome of [{ status: 'disabled' }, { status: 'failed', error: 'AccessDenied' }]) {
      assert.ok(composeNotice(alarm(), outcome, long).subject.length <= 100);
    }
  });
});

describe('composeNotice', () => {
  const site = { distributionId: 'E2EXAMPLE', site: 'example.com' };

  it('says why, when, and how to reopen', () => {
    const { message } = composeNotice(alarm(), { status: 'disabled' }, site);
    assert.match(message, /disabled CloudFront distribution E2EXAMPLE/);
    assert.match(message, /Threshold Crossed/);
    assert.match(message, /2026-10-24T21:00/);
    assert.match(message, /re-arms both alarms/);
    assert.doesNotMatch(message, /hours of/);
  });

  it('warns that a daily alarm trips again if reopened inside its window', () => {
    const { message } = composeNotice(
      alarm({ AlarmName: 'portfolio-kill-switch-24h', Trigger: { Period: 86400 } }),
      { status: 'disabled' },
      site,
    );
    assert.match(message, /last 24 hours\. Reopening within 24 hours/);
    assert.match(message, /kill_switch_daily_usd/);
  });
});

describe('killSwitchFromEnv', () => {
  const env = { DISTRIBUTION_ID: 'E2EXAMPLE', NOTIFY_TOPIC_ARN: 'arn:x', SITE_NAME: 'example.com' };

  it('builds from a complete environment', () => {
    assert.equal(typeof killSwitchFromEnv(env), 'function');
  });

  for (const name of Object.keys(env)) {
    it(`fails at startup without ${name}`, () => {
      assert.throws(() => killSwitchFromEnv({ ...env, [name]: undefined }), new RegExp(name));
    });
  }
});
