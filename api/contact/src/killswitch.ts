/**
 * The cost kill switch (infra/main/killswitch.tf).
 *
 * Two CloudWatch alarms estimate the CloudFront bill from the distribution's
 * own traffic, minute by minute. When one goes into ALARM, SNS invokes this
 * function, which disables the distribution and emails the owner.
 *
 * It only ever turns the site off. Turning it back on is a decision, made
 * with the "Reopen site" workflow, which also re-arms the alarms.
 *
 * A failure to disable is still reported by email, with the command to do
 * it by hand, rather than thrown: SNS would retry the invocation and send a
 * second email for the same alarm.
 */
import {
  CloudFrontClient,
  GetDistributionConfigCommand,
  UpdateDistributionCommand,
} from '@aws-sdk/client-cloudfront';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import type { SNSEvent } from 'aws-lambda';

/** The fields of a CloudWatch alarm notification this function reads. */
interface AlarmNotification {
  AlarmName: string;
  AlarmDescription?: string | null;
  NewStateValue: string;
  NewStateReason: string;
  StateChangeTime: string;
  Trigger?: { Period?: number };
}

export type Outcome =
  { status: 'disabled' } | { status: 'alreadyDisabled' } | { status: 'failed'; error: string };

export interface KillSwitchDeps {
  distributionId: string;
  notifyTopicArn: string;
  /** The domain, for the email subject. */
  site: string;
  cloudfront: Pick<CloudFrontClient, 'send'>;
  sns: Pick<SNSClient, 'send'>;
  log?: (entry: Record<string, unknown>) => void;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Sets Enabled=false, keeping the rest of the configuration as it is. */
export async function disableDistribution(
  cloudfront: KillSwitchDeps['cloudfront'],
  id: string,
): Promise<Outcome> {
  try {
    const current = await cloudfront.send(new GetDistributionConfigCommand({ Id: id }));
    const config = current.DistributionConfig;
    if (!config) throw new Error('GetDistributionConfig returned no configuration');
    if (!config.Enabled) return { status: 'alreadyDisabled' };

    await cloudfront.send(
      new UpdateDistributionCommand({
        Id: id,
        IfMatch: current.ETag,
        DistributionConfig: { ...config, Enabled: false },
      }),
    );
    return { status: 'disabled' };
  } catch (error) {
    return { status: 'failed', error: errorName(error) };
  }
}

/** The email: what happened, why, and what to do next. */
export function composeNotice(
  alarm: AlarmNotification,
  outcome: Outcome,
  deps: Pick<KillSwitchDeps, 'distributionId' | 'site'>,
): { subject: string; message: string } {
  const window = alarm.Trigger?.Period ?? 0;
  const lines: string[] = [];
  let subject: string;

  if (outcome.status === 'failed') {
    subject = `ACTION NEEDED: ${deps.site} cost alarm fired, kill switch FAILED`;
    lines.push(
      `The cost alarm fired, but disabling CloudFront distribution ${deps.distributionId} failed (${outcome.error}).`,
      'The site is still online. Disable it by hand: CloudFront console,',
      `Distributions, ${deps.distributionId}, Disable.`,
    );
  } else {
    subject = `${deps.site} is offline: CloudFront cost alarm`;
    lines.push(
      outcome.status === 'disabled'
        ? `The kill switch disabled CloudFront distribution ${deps.distributionId}.`
        : `CloudFront distribution ${deps.distributionId} was already disabled; nothing changed.`,
      'The site stays offline until you reopen it.',
    );
  }

  lines.push(
    '',
    `Alarm:  ${alarm.AlarmName}`,
    ...(alarm.AlarmDescription ? [`        ${alarm.AlarmDescription}`] : []),
    `Reason: ${alarm.NewStateReason}`,
    `At:     ${alarm.StateChangeTime}`,
  );

  if (outcome.status !== 'failed') {
    lines.push(
      '',
      'With no traffic served, the alarm returns to OK on its own. Check what',
      'happened first (CloudFront console, Monitoring), then reopen the site:',
      '',
      '  gh workflow run reopen-site.yml',
      '',
      'or GitHub, Actions, "Reopen site", Run workflow, then approve the infra',
      'deployment. It re-arms both alarms before switching the site back on.',
    );
    if (window >= 3600) {
      const hours = Math.round(window / 3600);
      lines.push(
        '',
        `This alarm counts the last ${hours} hours. Reopening within ${hours} hours of`,
        'the spike will trip it again, unless you raise its threshold first',
        '(kill_switch_daily_usd in terraform.tfvars).',
      );
    }
  }

  return { subject, message: lines.join('\n') };
}

export function createKillSwitch(deps: KillSwitchDeps) {
  const log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)));

  return async (event: SNSEvent): Promise<void> => {
    for (const record of event.Records) {
      const alarm = JSON.parse(record.Sns.Message) as AlarmNotification;
      // Only the transition into ALARM acts. OK notifications are not
      // configured, but ignoring them here keeps a misconfiguration harmless.
      if (alarm.NewStateValue !== 'ALARM') {
        log({ outcome: 'ignored', alarm: alarm.AlarmName, state: alarm.NewStateValue });
        continue;
      }

      const outcome = await disableDistribution(deps.cloudfront, deps.distributionId);
      log({ outcome: outcome.status, alarm: alarm.AlarmName, ...outcome });

      const { subject, message } = composeNotice(alarm, outcome, deps);
      await deps.sns.send(
        new PublishCommand({ TopicArn: deps.notifyTopicArn, Subject: subject, Message: message }),
      );
    }
  };
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

/**
 *   DISTRIBUTION_ID    the CloudFront distribution to disable
 *   NOTIFY_TOPIC_ARN   SNS topic with the owner's email subscribed
 *   SITE_NAME          the domain, for the email subject
 */
export function killSwitchFromEnv(env: Env) {
  return createKillSwitch({
    distributionId: required(env, 'DISTRIBUTION_ID'),
    notifyTopicArn: required(env, 'NOTIFY_TOPIC_ARN'),
    site: required(env, 'SITE_NAME'),
    cloudfront: new CloudFrontClient({}),
    sns: new SNSClient({}),
  });
}
