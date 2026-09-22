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

/**
 * Sources that invoke through a proxy integration and expect an HTTP response object back.
 *
 * API Gateway REST is the strict one. A payload-format-1.0 proxy integration whose function
 * returns anything without `statusCode` is answered to the caller as `502 Internal server error`,
 * and nothing on the Lambda side says so: the report is printed, the invocation succeeds, the
 * duration is normal. The whole failure lives on the gateway, which is why it reads as a broken
 * deployment rather than as a missing field.
 *
 * A function URL and an HTTP API (payload 2.0) infer a response instead of refusing one, so those
 * two worked already. They are listed here anyway — three ways in that answer one shape is a
 * smaller thing to hold than two that answer by accident and one that had to be fixed.
 */
const HTTP_PROXY = new Set(['aws:apigateway', 'aws:lambda_url']);

/**
 * The proxy-integration response.
 *
 * **200 even when a wire failed**, which is the answer `runtimes/container.ts` already gives to
 * the same question: the report *is* the result, a failed hop is a fact it carries rather than a
 * transport error, and `hops[].ok` names the wire and the reason. Here there is a second reason on
 * top of that one. A 502 is exactly what the gateway returns when the integration is misconfigured
 * — the symptom this change removes — so spending the same code on a reported wire failure would
 * make a working Hub with one bad destination indistinguishable from a Hub that was deployed
 * wrong.
 *
 * ⚠️ `report.failed` cannot carry a status here, and reading as though it could is the trap.
 * `Trail.record` adds to that list only when the item has an `id`, and an `id` exists solely for
 * sources that accept a partial-batch report — a queue or a stream. An HTTP arrival carries no id,
 * so `failed` is empty however many hops failed. A status derived from it answers 200 always,
 * which looks like the feature working and hides the one thing this package exists to show.
 */
const proxyResponse = (report: Report) => ({
	statusCode: 200,
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(report),
});

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
		if (BATCHED.has(arrival.origin)) return ack(report);

		// A proxy integration wants an HTTP response, not the report on its own.
		if (HTTP_PROXY.has(arrival.origin)) return proxyResponse(report);

		// Direct invocation, and anything else that reads the answer as a value: the report
		// unwrapped, which is what a caller doing `Payload` on an Invoke expects to parse.
		return report satisfies Report;
	};
}
