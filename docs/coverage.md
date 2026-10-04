# Coverage

What Hub can reach, what it cannot, and why. Derived from the catalog rather than from memory:
the candidate set is every type that a compute node can be wired to, plus every type that can be
wired into one. Fifty-three types qualify; the table below is what remains after removing the ones
with no data plane.

That count is not fixed: it is the catalog's, and the catalog moves. `aws_cloudwatch_event_bus`
joined it on 2026-09-26, when a connection from a compute node to a bus was added — until then no
workload could be wired to one, so no variable was emitted and there was nothing to reach.

Legend: **✓** shipped · **?** blocked on a decision

**Every applicable AWS resource is implemented**: 16 send targets and 12 event sources across 20
modules. What remains is the five below, each waiting on an answer rather than on work.

Nothing here has run against a live account yet. The suite proves the logic and the wiring over a
fake transport; it does not prove a signature AWS will accept.

---

## Why this is not a combinatorial problem

The obvious reading of "any resource must be able to reach any other" is a matrix: sources ×
targets. It is not.

The core fans out to whatever neighbor list it is given, and that behavior is tested once. What a
resource contributes is at most two small functions: how to send to it, and how to read an event
from it. So coverage is **sources + targets**, not their product — twenty-seven small functions,
not a hundred and eighty combinations.

The part of the matrix that does need asserting is that the sources stay distinct, and the
conformance suite does it: every fixture is offered to every receiver, and exactly one must claim
it. That is not ceremony. Six of these sources arrive under `Records`, and an API Gateway event
differs from a function URL event only by the domain name — a detector that is slightly too eager
quietly steals another source's traffic, and the symptom is a report that blames the wrong wire.

## What the suite demands of every module

Nobody writes a test for a new resource. `test/conformance.test.ts` iterates the registry and
applies the same rules to everything in it: capabilities must exist, keys must be in the grammar's
case, a sender must survive a wire carrying nothing but a name, a service refusal must surface as
a readable reason, and no receiver may throw on a malformed event.

It earns its keep. Run for the first time against the three resources that had been hand-tested
already, it failed two of them: with no `NAME` on the wire, the queue and topic senders composed a
URL and an ARN with an empty segment and sent to them, instead of refusing. Both were valid
strings, so nothing complained locally; against real AWS the answer would have been an error about
a queue that does not exist, which is a long way from *the wire carried no name*.

## Send — signed HTTP

The bulk of the work, and mechanical. Each is one file: build a request, sign it, hand it to
`ctx.fetch`.

| type | call | |
|---|---|---|
| `aws_sqs_queue` | `SendMessage` | ✓ |
| `aws_sns_topic` | `Publish` | ✓ |
| `aws_s3_bucket` | `PutObject` | ✓ |
| `aws_dynamodb_table` | `PutItem`, `UpdateItem` | ✓ |
| `aws_kinesis_stream` | `PutRecord` | ✓ |
| `aws_kinesis_firehose_delivery_stream` | `PutRecord` | ✓ |
| `aws_cloudwatch_log_group` | `PutLogEvents` | ✓ |
| `aws_lambda_function` | `Invoke` | ✓ |
| `aws_lambda_function_url` | plain HTTPS `POST` | ✓ |
| `aws_lb` | plain HTTPS `POST` to the DNS name | ✓ |
| `aws_appsync_graphql_api` | GraphQL `POST` | ✓ |
| `aws_ssm_parameter` | `PutParameter`, overwriting | ✓ |
| `aws_secretsmanager_secret` | `PutSecretValue` — see below | ✓ |
| `aws_kinesis_video_stream` | `DescribeStream` — reachability only, see below | ✓ |
| `aws_cloudwatch_event_bus` | `PutEvents` — see below | ✓ |

**The two parameter stores receive the message, like every other destination here.** They read
until 2026-09-05, because the wire's generated policy granted reading and nothing else — and a
report line for a wire that only confirmed a permission was shaped exactly like the S3 line beside
it, which is the silence this package exists to remove. The catalog now grants `ssm:PutParameter`
and `secretsmanager:PutSecretValue` on the wire that *leaves* a workload, matching what it already
granted for a bucket or a table.

A parameter is overwritten: it holds one value, and a read returns the last write. A secret has no
overwrite — `PutSecretValue` adds a version and moves `AWSCURRENT` onto it, which is the same thing
from the reader's side. The secret's value is still never logged and never put in the report.

The wire that *enters* a workload is a different thing and stays read-only: a parameter or secret
wired into an ECS box is injected into the container's `secrets`, and the reader there is ECS
itself as it starts the task.

**The event bus is the one destination that can refuse an event and still answer 200.** PutEvents
replies `FailedEntryCount: 1` with the reason in the body, so the sender reads the body — a hop
reported as delivered for an event that was never published is exactly the silence this package
exists to remove. Two other measurements from the same day, against the live API: a bus name that
does not exist is accepted with an EventId and the event is dropped, which is why the name is only
ever taken off the wire; and `Source` is required, so it and `DetailType` are constants here
(`struct8.hub`, `Hub Message`) because the contract carries neither. A rule on the bus has to match
them, and `{"source": ["struct8.hub"]}` matches everything Hub publishes from any workload.

The bus sends and never receives, the mirror of `aws_cloudwatch_event_rule`, which receives and
never sends: publishing happens at the bus, delivery happens at the rule. The two together close a
round trip — the detail Hub publishes is the sealed envelope, and the rule hands its target that
detail as an object, where the next Hub finds the trace and the remaining hops.

**Kinesis Video is described, not written to.** Ingestion means `PutMedia`, a long-lived chunked
upload of MKV fragments — a session, not a request. Synthesising a fragment out of a text message
would prove nothing about anybody's pipeline, so the hop means "the stream exists and the
permission is there".

**AppSync is introspected.** Nothing on the wire says what the schema looks like, so there is no
mutation that could be written blind. Introspection is the one query every GraphQL endpoint
answers.

## Send — a database connection

| type | how | |
|---|---|---|
| `aws_db_instance` | `INSERT` into `hub_messages`, Postgres family | ✓ |

**The one destination that is not an HTTPS request, so it has a port of its own.** A database is a
TCP connection and a wire protocol, and `fetch` cannot stand in for it. `providers/sql.ts` is the
port: the module asks for a connection by engine name, and a test hands it a driver that records
instead of connecting.

**The engine picks the driver, and the wire carries the engine.** `ENGINE` is exported by the
catalog from the instance's own `engine`. Nothing is guessed from a port number (a Postgres on
3306 is legal) and the RDS API is never called (it would need a permission the wire does not grant,
and an endpoint inside the VPC). An engine with no driver — `mysql` today — is refused by name,
and before the credential is read. Another engine of a family that has a driver is one line in
`FAMILIES`. A new family is also a driver file that registers itself, and the module's two
statements in that family's SQL: they are written in Postgres (`$1` placeholders, `timestamptz`,
`on conflict do nothing`), which MySQL does not accept.

**The driver is `pg`, bundled, with no Lambda layer.** The part of a client that goes wrong is
authentication (SCRAM-SHA-256), and the databases this reaches are private, so a mistake would
surface one apply at a time. The bundler inlines `pg` as it does `aws4fetch`, and the function
still ships one file. It takes the unminified bundle from 55 KiB to 241.

**The credential is read from the managed secret on every send.** The generated policy grants
`GetSecretValue` on exactly that secret. It is not cached (the secret rotates), not placed in an
environment variable (the function's configuration is readable) and not quoted in any error.

**The certificate authority is the Lambda runtime's own file.** From Node.js 20 on, Lambda does not
trust the RDS certificate authority by default, and the documented fix is an environment variable
Node reads at start-up. The driver reads `/var/runtime/ca-cert.pem` itself and hands it to the TLS
connection. The connection is never downgraded to an unverified one.

**One connection per send, with a five-second limit on each phase.** A function in a subnet with
no route to the database does not fail, it waits, and the wait is billed up to the function's own
timeout. Connection pooling belongs to the proxy, not to a warm container that holds a slot of a
small instance.

**Needs a route to the database and to Secrets Manager.** The function has to be in a subnet, and
a subnet with no NAT reaches Secrets Manager only through an interface endpoint.

Nothing here has run against a real database. The suite proves the logic over a fake driver; the
handshake, the certificate chain and the table creation are the first things to read in the
report after the first apply.

## Receive — event sources

| type | arrives as | |
|---|---|---|
| `aws_sqs_queue` | `Records[].eventSource == aws:sqs` | ✓ |
| `aws_sns_topic` | `Records[].Sns` | ✓ |
| `aws_s3_bucket` | `Records[].s3` | ✓ |
| `aws_dynamodb_table` | `Records[].dynamodb` (stream) | ✓ |
| `aws_kinesis_stream` | `Records[].kinesis`, base64 | ✓ |
| `aws_cloudwatch_event_rule` | `source == aws.events` | ✓ |
| `aws_api_gateway_rest_api` | proxy envelope, or the bare payload | ✓ |
| `aws_lb` | `requestContext.elb` | ✓ |
| `aws_lambda_function_url` | HTTP v2 envelope | ✓ |
| `aws_lambda_function` | direct invoke | ✓ |
| `aws_cognito_user_pool` | trigger event | ✓ |
| `aws_cloudfront_distribution` | Lambda@Edge event | ✓ |

## Blocked on a decision

Not oversights. Each needs an answer before it can be written.

| type | why | the question |
|---|---|---|
| `aws_rds_cluster` | the catalog exports no endpoint, database or secret for it | export them as `aws_db_instance` does; its `aurora-postgresql` engine already has a driver |
| `aws_elasticache_replication_group` | Redis wire protocol over TCP | a driver would have to be shipped, as it was for databases, and none is |
| `aws_efs_access_point`, `aws_efs_file_system` | POSIX writes through a mount | only works where the filesystem is mounted; a Worker can never do it |
| `aws_instance` | needs `ec2:DescribeInstances` to find the host | the generated policy does not grant it — change the wire's policy, or drop the type? |
| `aws_ecs_task_definition`, `aws_service_discovery_service` | needs service discovery to resolve a target | same shape as the one above |

The predecessor's EC2 block carries the answer to the fourth one in a comment: *"sem uma policy
escrita a mão, este bloco falha sempre."* It was written, shipped, and never worked.

## Not applicable

Wired to compute for reasons that have nothing to do with data, and with no data plane to reach:

`aws_security_group` · `aws_subnet` · `aws_iam_policy` · `aws_kms_key` · `aws_key_pair` ·
`aws_route_table` · `aws_vpc_endpoint_interface` · `aws_ebs_volume` · `aws_launch_template` ·
`aws_ecs_capacity_provider` · `aws_eks_node_group` · `aws_autoscaling_group` ·
`aws_lambda_layer_version` · `aws_elastic_beanstalk_environment` · `aws_ecr_repository` ·
`aws_cognito_user_pool_client` · `aws_bedrock_*` · `aws_appsync_datasource` · `kubernetes_*`

Two more are the wire itself rather than a destination, and are covered by the resource on the
far side: `aws_s3_bucket_notification` and `aws_lambda_event_source_mapping`.
`aws_sqs_queue_dlq` is a queue and is covered by the queue.

## What the predecessor claimed and did not do

`LambdaHub2.py` lists sixteen types in its parser vocabulary. Three have no send block and no
initialization block anywhere in the file — `aws_lambda_function_url`, `aws_efs_file_system`,
`aws_elasticache_replication_group`. Wire one of those in a diagram and the variable is emitted,
the neighbor is discovered, the discovery log prints it, and nothing happens. No error, no
warning.

A fourth, `aws_codebuild_project`, has a working send block for a type that is not in the catalog
at all, so the variable it waits for can never be emitted.

Its own header warned about exactly this: *"Tipo novo aqui exige também um bloco de envio lá
embaixo — sem ele a variável é reconhecida e nada acontece."* The warning was correct and did not
help, which is why the vocabulary here is derived from the registry and a module with neither
`send` nor `receive` is refused at load.
