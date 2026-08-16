/**
 * The AWS Lambda shim.
 *
 * Everything interesting happens in the core; this file only answers two questions the platform
 * asks differently from every other one: how the message arrives, and what shape the answer takes.
 */

import { discover } from '../core/discovery.js';
import { ack, handle, normalize } from '../core/hub.js';
import * as registry from '../core/registry.js';
import type { Ctx, Neighbor, Report } from '../core/types.js';

/** The fields of the Lambda context object this shim reads. */
export interface LambdaContext {
	readonly functionName?: string;
	readonly invokedFunctionArn?: string;
}

/** Sources that deliver a batch and accept a partial-failure report. */
const BATCHED = new Set(['aws:sqs', 'aws:kinesis', 'aws:dynamodb']);

const env = (name: string): string | undefined =>
	typeof process === 'undefined' ? undefined : (process.env as Record<string, string | undefined>)[name];

/**
 * The account id, which is harder to obtain than it looks.
 *
 * The generator emits `ACCOUNT` only when a resource lives in a *different* account, and AWS
 * publishes the account id in no environment variable of its own. On the ordinary path — a queue
 * in the same account — the variable is absent, every composed SQS URL comes out as
 * `.../undefined/name`, and every send fails. The invocation's own ARN is the one place it can
 * always be recovered from.
 */
const accountFrom = (context: LambdaContext): string | undefined =>
	env('ACCOUNT') ?? context.invokedFunctionArn?.split(':')[4] ?? undefined;

export interface LambdaOptions {
	/** Forward budget for messages entering the chain here. */
	readonly hops?: number;
}

/**
 * Builds the handler.
 *
 * ```js
 * import { hub } from '@struct8/hub';
 * import '@struct8/hub/r/aws_sqs_queue';
 * export const handler = hub.lambda();
 * ```
 */
export function lambda(opts: LambdaOptions = {}) {
	let neighbors: readonly Neighbor[] | undefined;

	return async function handler(event: unknown, context: LambdaContext = {}): Promise<unknown> {
		// Resolved on first invocation rather than at module load, so that a shim which registers
		// resources after calling lambda() still sees a complete vocabulary.
		neighbors ??= discover(typeof process === 'undefined' ? {} : process.env, registry.vocabulary());

		const self =
			env('LAMBDA_NAME') ?? env('NAME') ?? env('AWS_LAMBDA_FUNCTION_NAME') ?? context.functionName ?? 'hub';
		const ownRegion = env('REGION') ?? env('AWS_REGION');
		const ownAccount = accountFrom(context);

		const ctx: Ctx = {
			self,
			fetch: globalThis.fetch,
			region: (n) => n?.props['REGION'] ?? ownRegion,
			account: (n) => n?.props['ACCOUNT'] ?? ownAccount,
			now: () => new Date(),
		};

		const arrival = await normalize(event);
		const report = await handle(arrival, neighbors, ctx, opts.hops === undefined ? {} : { hops: opts.hops });

		console.log(JSON.stringify({ hub: report, describe: arrival.describe }));

		// The batch contract is not optional. An absent list makes the source treat every message
		// as failed and redeliver the lot; on a stream the checkpoint rewinds to the lowest
		// sequence number reported and everything after it comes back too.
		return BATCHED.has(arrival.origin) ? ack(report) : (report satisfies Report);
	};
}
