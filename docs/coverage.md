# Coverage

What Hub can reach, what it cannot, and why. Derived from the catalog rather than from memory:
the candidate set is every type that a compute node can be wired to, plus every type that can be
wired into one. Fifty-four types qualify; the table below is what remains after removing the ones
with no data plane.

That count is not fixed: it is the catalog's, and the catalog moves. `aws_cloudwatch_event_bus`
joined it on 2026-09-26, when a connection from a compute node to a bus was added — until then no
workload could be wired to one, so no variable was emitted and there was nothing to reach.
`aws_db_proxy` joined it on 2026-10-03 the same way, when a compute node could be connected to a
proxy as it is to the database behind it. `aws_opensearch_domain` could be connected from
2026-09-22 and carried only its logical name until 2026-10-05, when the catalog started exporting
its endpoint. `aws_docdb_cluster` joined it the same day: until then no compute node could be
connected to a DocumentDB cluster at all.

Legend: **✓** shipped · **?** blocked on a decision

**Every applicable AWS resource is implemented**: 20 send targets and 12 event sources across 24
modules. What remains is the four below, each waiting on an answer rather than on work.

Nothing here has run against a live account yet. The suite proves the logic and the wiring over a
fake transport; it does not prove a signature AWS will accept.

---

## Why this is not a combinatorial problem

The obvious reading of "any resource must be able to reach any other" is a matrix: sources ×
targets. It is not.

The core fans out to whatever neighbor list it is given, and that behavior is tested once. What a
resource contributes is at most two small functions: how to send to it, and how to read an event
from it. So coverage is **sources + targets**, not their product — thirty-two small functions,
not two hundred and forty combinations.

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
| `aws_opensearch_domain` | `PUT /hub_messages/_create/<id>` — see below | ✓ |

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

**An OpenSearch domain keeps the message as a document of `hub_messages`** — the fields of the
database row (`providers/record.ts`) plus `stored_at`, at `PUT /hub_messages/_create/<id>`, signed
for `es` with the workload's role. The id is the hash of what identifies a message, and `_create`
answers 409 for one already there: a redelivery is not a second document. The index is created with
its mapping (identifying fields as `keyword`, both times as `date`) the first time a container
writes to the domain; one that exists is kept, and a role that may not create indexes still writes.
The catalog exports `ENDPOINT`, and the connection's policy statement grants `es:ESHttp*` on the
domain's subresources, which is enough on a domain with no access policy of its own. Every domain
drawn in CloudMan lives in a VPC: the workload has to be in a subnet of it, and the domain's security
group has to admit it on 443. With fine-grained access control on, the role also has to be mapped
inside OpenSearch, and the failure says so. OpenSearch Serverless is not reachable: no compute can
be connected to a collection.

## Send — a database connection

| type | how | |
|---|---|---|
| `aws_db_instance` | `INSERT` into `hub_messages`, Postgres family | ✓ |
| `aws_db_proxy` | the same `INSERT`, through the proxy — see below | ✓ |
| `aws_rds_cluster` | the same `INSERT`, over TCP or through the RDS Data API — see below | ✓ |

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
still ships one file. It takes the unminified bundle from 55 KiB to 241 (265 with IAM login and
the Data API).

**There is no MySQL driver, on purpose.** `mysql2`, bundled, is 1.3 MiB — five times everything
else together — and every function would carry it. An Aurora MySQL cluster is written through the
Data API instead (below), which needs no driver; a MySQL instance over TCP is refused by name.

**The credential is read from the managed secret on every send.** The generated policy grants
`GetSecretValue` on exactly that secret. It is not cached (the secret rotates), not placed in an
environment variable (the function's configuration is readable) and not quoted in any error.

**The certificate authorities are Node's own plus the Lambda runtime's file.** From Node.js 20 on,
Lambda does not trust the RDS certificate authority by default, and the documented fix is an
environment variable, `NODE_EXTRA_CA_CERTS`, that Node reads at start-up. The driver reads
`/var/runtime/ca-cert.pem` itself and adds it to the authorities Node already trusts, as the
variable does. Handing the file alone to the connection would replace them instead, and an RDS
Proxy's certificate comes from AWS Certificate Manager and chains to an Amazon Root CA, which is in
Node's list. A container has no such file: the image fetches the RDS bundle when it is built and
sets the variable itself (`image/Dockerfile`). Until 2026-10-05 it did not, and a container could
not verify a database's certificate. The connection is never downgraded to an unverified one.

**A proxy is a way into a database, not a database of its own.** `aws_db_proxy` writes the same row
into the same table; what differs is how the wire says where to connect. `ENDPOINT` is the proxy's
host alone, and `PORT` is fixed by its engine family. `ENGINE_FAMILY` (`POSTGRESQL`, `MYSQL`,
`SQLSERVER`) picks the driver, as `ENGINE` does for an instance. `DB_NAME` is the name of the
database the proxy is connected to, because the proxy keeps none of its own: a proxy connected to
no database is refused by name.

`SECRET_ARN` is the secret of the proxy's first `auth` entry. Under Secrets Manager authentication
the proxy checks a client's user name and password against its secrets, so the secret the proxy
logs in to the database with is also the one a client logs in to the proxy with, and the generated
policy grants the workload `GetSecretValue` on it. An `auth` entry with `iam_auth = REQUIRED`
refuses the password: the wire then carries `IAM_AUTH=REQUIRED`, and the client reads the secret
for its user name only and logs in as that user with a token made for the proxy's endpoint; the
generator grants `rds-db:connect` on the proxy. A proxy with `default_auth_scheme = IAM_AUTH`
exports no secret, and a client reaches it only as the user a policy on its role names
(`IAM_USER`); without one it is refused by name.

**An Aurora cluster is reached three ways, and the wire says which.** One cluster can serve a
function that logs in with the master secret, one that logs in as an IAM user and one outside the
VPC, so the decision is per wire, made by the compile from how each function is drawn:

- `DATA_API=true`: the function has no network interface and the cluster has its Data API on. It
  has no network path to the cluster, and the statement goes to the RDS Data API over HTTPS
  (`providers/dataApi.ts`): `POST /Execute`, signed for `rds-data`, addressed to `ARN` and logged in
  with `SECRET_ARN`. It answers the same `Connection` the TCP driver does, so the row is the same;
  `$n` placeholders become `:pn` named parameters.
- `IAM_USER=<user>`: the function's role is granted `rds-db:connect` for that user. It connects to
  `ENDPOINT:PORT` and logs in as the user with a token (`providers/rdsIam.ts`), a SigV4 presigned
  URL for `rds-db` that the test checks against a signature computed from the specification.
- neither: it connects and logs in with the master user's secret, as an instance wire does.

An engine with no driver — Aurora MySQL — goes through the Data API whenever the wire carries
`ARN`, which it does while the cluster's Data API is on. From inside a VPC that needs a NAT gateway
or an `rds-data` interface endpoint, and a request that gets no answer says so.

**An IAM user the database does not have is created.** A diagram can draw the grant
(`rds-db:connect`) and cannot draw the user it names: a user is created inside the database, with
SQL. When the token is refused as a password (`28P01` — the user does not exist, or is not a member
of `rds_iam`) on a database reached directly, the module logs in with the master secret the wire
also carries, creates the user, grants it `rds_iam`, and logs in again. Only a user that does not
exist is created: `GRANT rds_iam` ends a user's password login, so an existing user, and the
master user above all, is left as it is and the refusal says why. When the IAM user may not write
— no table yet and no right to create one in `public` (PostgreSQL 15 and later), or a table it was
never granted — the master user creates the table and grants it `INSERT`, once. Through a proxy
none of this happens: there the user is the proxy's.

**A user that may not create the table still writes into it.** `create table if not exists` is
checked against the schema before the table is looked for, so it fails for such a user even when
the table is there; that refusal (`42501`) is passed over and the insert decides.

**A paused cluster is waited for.** An Aurora Serverless v2 cluster with a minimum of 0 ACUs pauses
when idle, and the first connection resumes it in about fifteen seconds, longer after a day. Over
TCP an Aurora cluster gets twenty seconds to accept a connection instead of five; through the Data
API, a `DatabaseResumingException` is retried for up to twenty-five seconds. A function that cannot
reach the cluster at all now waits the twenty seconds before saying so, and the message names both
causes.

**One connection per send, with a five-second limit on each phase.** A function in a subnet with
no route to the database does not fail, it waits, and the wait is billed up to the function's own
timeout. Connection pooling belongs to the proxy, not to a warm container that holds a slot of a
small instance. The limit on a statement is the client's: `statement_timeout` in the startup
message makes an RDS Proxy refuse the connection (0A000, measured on the first apply), and a `SET`
after connecting would pin the session to one database connection.

**Needs a route to the database and to Secrets Manager.** The function has to be in a subnet, and
a subnet with no NAT reaches Secrets Manager only through an interface endpoint. The exception is
the Data API, which a function outside every VPC reaches over the internet.

The instance path has run against a real database: on 2026-10-04 a function connected to a
Postgres instance reported its hop as delivered (`ok: true`) every minute, in about 100 ms. The
proxy path got as far as the startup message the same day: the secret was read, the proxy's
certificate was verified, and the proxy refused `statement_timeout`, which the driver no longer
sends. Authentication through the proxy and the write have not run yet. None of the Aurora paths,
IAM login or the Data API has run against a live database yet: the token is checked against the
signature specification and the Data API against its documented request, both offline.

## Send — a document database

| type | how | |
|---|---|---|
| `aws_docdb_cluster` | `insert` into `hub.hub_messages`, over the MongoDB wire protocol | ✓ |

**The same record, as a document.** The fields of the database row (`providers/record.ts`), the
identity as `_id`, `sent_at` and `stored_at` as dates, in the collection `hub_messages` of a
database the Hub names `hub`: a DocumentDB cluster is created with no database, and the first insert
creates both. A redelivery is refused as a duplicate key (11000), which is the message already
stored, as `on conflict do nothing` is in SQL. An index on `trace` is created the first time a
container writes to a cluster, and a user that may not create it still writes.

**The protocol is written here, not bundled, for a reason Postgres did not have.**
`providers/postgres.ts` takes `pg` because a mistake in SCRAM fails only against a real server.
SCRAM has published test vectors, and the suite checks this exchange against three of them, message
for message: RFC 5802 (SHA-1), RFC 7677 (SHA-256), and the example in the MongoDB authentication
specification, which hashes MongoDB's digest of the password instead of the password. The rest is
small: BSON for the values written (every type is decoded, because the answer is the server's to
shape), one OP_MSG per command, and an `isMaster` to learn the mechanisms. The official driver
brings connection pools, server monitoring and a dependency tree, for one insert, into a bundle kept
readable on purpose. None of that is needed here: the cluster endpoint always names the primary,
and one insert per message needs no pool. The module, BSON and the protocol together add 27 KiB to
the bundle.

**SCRAM-SHA-256 when the user has it, SCRAM-SHA-1 otherwise.** `isMaster` with
`saslSupportedMechs` answers which. DocumentDB has SCRAM-SHA-256 from engine 5.0.1 and 8.0.1, and a
server that lists nothing takes SCRAM-SHA-1. The server's final signature is checked: a server that
cannot produce it does not know the password, and is not written to.

**TLS, always, verified against the Amazon RDS certificate authorities**, which issue DocumentDB's
certificates too (`providers/rdsCa.ts`, shared with the Postgres driver). On Lambda they are in
`/var/runtime/ca-cert.pem`. The container image fetches the RDS bundle when it is built and points
`NODE_EXTRA_CA_CERTS` at it, which also lets a Postgres connection from a container verify. A cluster
whose parameter group turns TLS off fails the handshake, and the message says so.

**The catalog exports `ENDPOINT`, `PORT` and `SECRET_ARN`**, the last only while DocumentDB manages
the master password, which is the catalog's default. The generated policy grants `GetSecretValue` on
that secret — on an ECS task definition to the task role too, where the code runs — and the
connection carries the rule that opens the port on the cluster's security group. A cluster with a
typed password exports no secret and is refused before anything is read.

**Needs a route to the cluster and to Secrets Manager**, as a relational database does: the
workload in a subnet of the cluster's VPC, and Secrets Manager through a NAT gateway or an interface
endpoint. A connection with no answer in five seconds says to look at the subnet and the security
group.

Not covered: IAM authentication (`MONGODB-AWS`), which needs a user created for the role inside the
cluster, and elastic clusters, which the catalog does not have. Nothing of this has run against a
live cluster yet. The TLS path was checked against a local server whose authority was trusted
through `NODE_EXTRA_CA_CERTS`, as in the image.

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
