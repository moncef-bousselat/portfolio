/**
 * Lambda entry point of the kill switch (handler setting:
 * killswitch.handler). Configuration is read once, at cold start.
 */
import { killSwitchFromEnv } from './killswitch.ts';

export const handler = killSwitchFromEnv(process.env);
