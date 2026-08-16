import { register } from '../../core/registry.js';
import type { Arrival } from '../../core/types.js';

interface CognitoTrigger {
	readonly triggerSource?: string;
	readonly userPoolId?: string;
	readonly userName?: string;
	readonly request?: unknown;
}

register({
	type: 'aws_cognito_user_pool',
	capabilities: ['function'],

	/**
	 * Receive only, and with a caution the report cannot express on its own.
	 *
	 * A user pool trigger is *synchronous and in the critical path of somebody signing in*. Unlike
	 * every other source here, what this workload returns decides whether the user gets in. Hub
	 * fans out and reports; it does not modify the event, so the pool sees an unchanged response
	 * and the sign-in proceeds as it would have.
	 *
	 * The forwarding is still real, so a slow destination slows down a login. Worth knowing before
	 * wiring this one to a long chain.
	 */
	receive(raw): Arrival | null {
		const event = raw as CognitoTrigger | null;
		if (typeof event?.triggerSource !== 'string' || typeof event.userPoolId !== 'string') return null;

		return {
			origin: 'aws:cognito',
			describe: `Cognito ${event.triggerSource} on ${event.userPoolId}`,
			items: [{ body: `${event.triggerSource} for ${event.userName ?? 'unknown user'}` }],
		};
	},
});
