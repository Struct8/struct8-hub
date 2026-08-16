/**
 * One sample event per source, shaped the way AWS actually delivers it.
 *
 * These exist to be fed to *every* receiver, not just the one that should claim them. A source is
 * only correctly implemented if its own receiver recognises it and all the others refuse it —
 * several of these envelopes look alike, and the ones that look alike are exactly where a lazy
 * detector goes wrong. An API Gateway v2 event and a function URL event are the same shape apart
 * from the domain; ALB, SQS, SNS, S3, Kinesis and DynamoDB streams all arrive under `Records`.
 */

export const EVENTS: Record<string, unknown> = {
	'aws:sqs': {
		Records: [
			{
				messageId: 'm-1',
				eventSource: 'aws:sqs',
				eventSourceARN: 'arn:aws:sqs:us-east-1:111122223333:OrdersQueue',
				body: 'hello from the queue',
			},
		],
	},

	'aws:sns': {
		Records: [
			{
				EventSource: 'aws:sns',
				Sns: {
					TopicArn: 'arn:aws:sns:us-east-1:111122223333:Alerts',
					Message: 'hello from the topic',
				},
			},
		],
	},

	// Key deliberately not a text extension: the S3 receiver fetches the object only for text, and
	// a fixture must never reach the network.
	'aws:s3': {
		Records: [
			{
				eventSource: 'aws:s3',
				awsRegion: 'us-east-1',
				s3: { bucket: { name: 'my-bucket' }, object: { key: 'photos/cat.jpg', size: 4096 } },
			},
		],
	},

	'aws:dynamodb': {
		Records: [
			{
				eventSource: 'aws:dynamodb',
				eventName: 'INSERT',
				eventSourceARN: 'arn:aws:dynamodb:us-east-1:111122223333:table/Events/stream/2026',
				dynamodb: { SequenceNumber: '100', Keys: { ID: { S: '1' } } },
			},
		],
	},

	// "aGVsbG8gZnJvbSB0aGUgc3RyZWFt" is "hello from the stream".
	'aws:kinesis': {
		Records: [
			{
				eventSource: 'aws:kinesis',
				eventSourceARN: 'arn:aws:kinesis:us-east-1:111122223333:stream/Events',
				kinesis: { sequenceNumber: '200', data: 'aGVsbG8gZnJvbSB0aGUgc3RyZWFt' },
			},
		],
	},

	'aws.events': {
		version: '0',
		source: 'aws.events',
		'detail-type': 'Scheduled Event',
		time: '2026-08-16T12:00:00Z',
		resources: ['arn:aws:events:us-east-1:111122223333:rule/EveryFiveMinutes'],
		detail: {},
	},

	'aws:apigateway': {
		version: '2.0',
		rawPath: '/orders',
		body: 'hello from the api',
		requestContext: {
			apiId: 'abc123',
			domainName: 'abc123.execute-api.us-east-1.amazonaws.com',
			stage: 'prod',
			http: { method: 'POST', path: '/orders' },
		},
	},

	'aws:lambda_url': {
		version: '2.0',
		rawPath: '/',
		body: 'hello from the function url',
		requestContext: {
			domainName: 'abcdefg.lambda-url.us-east-1.on.aws',
			http: { method: 'POST', path: '/' },
		},
	},

	'aws:elb': {
		httpMethod: 'POST',
		path: '/health',
		body: 'hello from the load balancer',
		requestContext: {
			elb: { targetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:111122223333:targetgroup/tg/abc' },
		},
	},

	'aws:cognito': {
		triggerSource: 'PostConfirmation_ConfirmSignUp',
		userPoolId: 'us-east-1_abc123',
		userName: 'someone',
		request: {},
	},

	'aws:cloudfront': {
		Records: [
			{
				cf: {
					config: { distributionId: 'E123ABC', eventType: 'viewer-request' },
					request: { method: 'GET', uri: '/index.html' },
				},
			},
		],
	},

	// A hub invoked by another hub: the payload is the envelope itself, already parsed.
	'aws:lambda': {
		$hub: 1,
		trace: 'T-fixture',
		hops: 2,
		path: ['Upstream'],
		at: '2026-08-16T12:00:00.000Z',
		body: 'hello from upstream',
	},
};

/** Something no receiver should ever claim. */
export const FOREIGN: unknown = { hello: 'world', Records: [{ somethingElse: true }] };
