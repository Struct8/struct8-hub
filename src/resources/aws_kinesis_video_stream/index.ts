import { register } from '../../core/registry.js';
import * as aws from '../../providers/aws.js';

register({
	type: 'aws_kinesis_video_stream',
	capabilities: ['stream'],

	/**
	 * Describes the stream instead of writing to it, and the distinction is worth being clear
	 * about.
	 *
	 * Ingesting into Kinesis Video means `PutMedia`: a long-lived chunked upload of MKV fragments
	 * to a per-stream data endpoint. That is not a request, it is a session, and synthesising a
	 * valid fragment out of a text message would prove nothing about anybody's pipeline.
	 *
	 * So this wire is exercised by resolving the stream. The report line means "the stream exists,
	 * the name resolved, the permission is there" — not "media arrived". Anything stronger would
	 * need the diagram to say what the media is, which no wire can.
	 */
	async send(n, _envelope, ctx) {
		const stream = n.props['NAME'];
		if (!stream) throw new Error('no stream name on the wire');

		const region = ctx.region(n);
		if (!region) throw new Error('no region for the stream and none for the workload');

		// Kinesis Video is REST-JSON on a path, not a JSON-RPC target like the other Kinesis APIs.
		await aws.rest(
			`${aws.endpoint('kinesisvideo', region)}/describeStream`,
			'kinesisvideo',
			region,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ StreamName: stream }),
			},
			'kinesisvideo:DescribeStream',
			ctx.fetch
		);
	},
});
