/**
 * Writing to an Aurora cluster over HTTP: the RDS Data API.
 *
 * A function outside the VPC has no network path to a cluster in a private subnet, and the Data
 * API is the way in that does not need one: `POST https://rds-data.<region>.amazonaws.com/Execute`,
 * signed for `rds-data`, with the statement, the cluster's ARN and a secret to log in with. The
 * service connects on the function's behalf.
 *
 * It hands back the {@link Connection} the TCP drivers hand back, so the module that writes the row
 * does not know which of the two reached the database. Two things differ and are absorbed here:
 *
 *   * Placeholders. The Data API takes named parameters, `:name`, and the shared notation is `$1`.
 *     `$n` becomes `:pn`, and the n-th value becomes the parameter named `pn`.
 *   * The pause. An Aurora Serverless v2 cluster with a minimum of 0 ACUs stops when idle, and a
 *     request that finds it stopped is answered `DatabaseResumingException` while it starts again,
 *     typically for about fifteen seconds. The request is repeated until it is not, for as long as
 *     RESUME_WAITS_MS allows, instead of failing the hop the first time.
 *
 * What it needs on the AWS side: the cluster's Data API turned on (`enable_http_endpoint`), and on
 * the function's role `rds-data:ExecuteStatement` on the cluster and `secretsmanager:GetSecretValue`
 * on the secret, which the service reads with the caller's own permission.
 */

import * as aws from './aws.js';
import type { Connection } from './sql.js';

/** Where the Data API sends the statement. */
export interface DataApiTarget {
	readonly resourceArn: string;
	readonly secretArn: string;
	readonly database: string;
	readonly region: string;
}

export interface DataApiOptions {
	/** Test seam: how to wait between attempts while the cluster resumes. */
	readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * The waits between attempts while a paused cluster resumes, in milliseconds: twenty-five seconds
 * in all. AWS gives fifteen as the typical resume, and thirty or more after a day paused; past the
 * last wait the hop fails, and the request that failed has already woken the cluster for the next
 * run.
 */
const RESUME_WAITS_MS: readonly number[] = [2000, 3000, 5000, 5000, 5000, 5000];

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `$1` → `:p1`, the notation the Data API reads. */
export const named = (text: string): string => text.replace(/\$(\d+)/g, ':p$1');

/** One value as the Data API types it. */
export function field(value: unknown): Record<string, unknown> {
	if (value === null || value === undefined) return { isNull: true };
	if (typeof value === 'boolean') return { booleanValue: value };
	if (typeof value === 'number') return Number.isInteger(value) ? { longValue: value } : { doubleValue: value };
	return { stringValue: String(value) };
}

/** The Data API's answer while an auto-paused cluster starts again. */
const resuming = (err: unknown): boolean => err instanceof Error && /^DatabaseResumingException\b/.test(err.message);

/**
 * Turns a failure into a line a report can carry, with the database's SQLSTATE in `code`.
 *
 * The SQLSTATE is in the message (`...; SQLState: 42P01`), and the caller decides on some of them
 * (`providers/hubMessages.ts`). A request that never got an answer is a `TypeError` from `fetch`:
 * from a function in a VPC that is a missing route to the service, and the pointer says so.
 */
function describe(err: unknown): Error {
	if (err instanceof TypeError) {
		const cause = (err as { cause?: { code?: unknown; message?: unknown } }).cause;
		const why = typeof cause?.code === 'string' ? cause.code : typeof cause?.message === 'string' ? cause.message : err.message;
		return new Error(
			`the Data API did not answer (${why}): a function in a VPC reaches it through a NAT gateway or an rds-data interface endpoint`
		);
	}

	const message = err instanceof Error ? err.message : String(err);
	let hint = '';
	if (/^(AccessDeniedException|ForbiddenException)\b/.test(message)) {
		hint = " (the function's role needs rds-data:ExecuteStatement on the cluster and secretsmanager:GetSecretValue on its secret)";
	} else if (/HttpEndpoint is not enabled/i.test(message)) {
		hint = ' (turn on the Data API of the cluster: enable_http_endpoint)';
	}

	const described = new Error(`${message}${hint}`);
	const code = /SQLState: ([0-9A-Z]{5})/.exec(message)?.[1];
	return code ? Object.assign(described, { code }) : described;
}

/** A connection to `target` through the Data API. Opening it costs nothing; each statement is a request. */
export function connection(target: DataApiTarget, fetchImpl: typeof fetch, options: DataApiOptions = {}): Connection {
	const sleep = options.sleep ?? pause;

	return {
		async run(text, params = []) {
			const body = JSON.stringify({
				resourceArn: target.resourceArn,
				secretArn: target.secretArn,
				database: target.database,
				sql: named(text),
				parameters: params.map((value, i) => ({ name: `p${i + 1}`, value: field(value) })),
			});

			for (let attempt = 0; ; attempt++) {
				try {
					await aws.rest(
						`${aws.endpoint('rds-data', target.region)}/Execute`,
						'rds-data',
						target.region,
						{ method: 'POST', headers: { 'content-type': 'application/json' }, body },
						'ExecuteStatement',
						fetchImpl
					);
					return;
				} catch (err) {
					const wait = RESUME_WAITS_MS[attempt];
					if (wait !== undefined && resuming(err)) {
						await sleep(wait);
						continue;
					}
					throw describe(err);
				}
			}
		},

		// Nothing is held open between requests.
		async close() {},
	};
}
