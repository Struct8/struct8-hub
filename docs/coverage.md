# Coverage

What Hub can reach, what it cannot, and why. Derived from the catalog rather than from memory:
the candidate set is every type that a compute node can be wired to, plus every type that can be
wired into one. Fifty-two types qualify; the table below is what remains after removing the ones
with no data plane.

Legend: **✓** shipped · **·** planned · **?** blocked on a decision

---

## Why this is not a combinatorial problem

The obvious reading of "any resource must be able to reach any other" is a matrix: sources ×
targets. It is not.

The core fans out to whatever neighbor list it is given, and that behavior is tested once. What a
resource contributes is at most two small functions: how to send to it, and how to read an event
from it. So coverage is **sources + targets**, not their product — about forty small functions,
not four hundred combinations.

The matrix is still worth asserting, and it is cheap: a generated test that pairs every receiver
with every sender over a fake transport. It proves the wiring, not the network.

## Send — signed HTTP

The bulk of the work, and mechanical. Each is one file: build a request, sign it, hand it to
`ctx.fetch`.

| type | call | |
|---|---|---|
| `aws_sqs_queue` | `SendMessage` | ✓ |
| `aws_sns_topic` | `Publish` | ✓ |
| `aws_s3_bucket` | `PutObject` | ✓ |
| `aws_dynamodb_table` | `PutItem`, `UpdateItem` | · |
| `aws_kinesis_stream` | `PutRecord` | · |
| `aws_kinesis_firehose_delivery_stream` | `PutRecord` | · |
| `aws_cloudwatch_log_group` | `PutLogEvents` | · |
| `aws_lambda_function` | `Invoke` | · |
| `aws_lambda_function_url` | plain HTTPS `POST` | · |
| `aws_lb` | plain HTTPS `POST` to the DNS name | · |
| `aws_appsync_graphql_api` | GraphQL `POST` | · |
| `aws_ssm_parameter` | `GetParameter` — read, see below | · |
| `aws_secretsmanager_secret` | `GetSecretValue` — read, see below | · |
| `aws_kinesis_video_stream` | `PutMedia` — streaming, not a single request | ? |

**Read, not write, for the two parameter stores.** The policy the generator writes for those wires
grants `GetParameter` / `GetSecretValue`. A `PutParameter` would fail on permission in every
diagram that has not been edited by hand, so the wire is exercised by reading and reporting what
came back. That is still a real proof the wire works.

## Receive — event sources

| type | arrives as | |
|---|---|---|
| `aws_sqs_queue` | `Records[].eventSource == aws:sqs` | ✓ |
| `aws_sns_topic` | `Records[].Sns` | ✓ |
| `aws_s3_bucket` | `Records[].s3` | ✓ |
| `aws_dynamodb_table` | `Records[].dynamodb` (stream) | · |
| `aws_kinesis_stream` | `Records[].kinesis`, base64 | · |
| `aws_cloudwatch_event_rule` | `source == aws.events` | · |
| `aws_api_gateway_rest_api` | proxy envelope, or the bare payload | · |
| `aws_lb` | `requestContext.elb` | · |
| `aws_lambda_function_url` | HTTP v2 envelope | · |
| `aws_lambda_function` | direct invoke | · |
| `aws_cognito_user_pool` | trigger event | · |
| `aws_cloudfront_distribution` | Lambda@Edge event | · |

## Blocked on a decision

Not oversights. Each needs an answer before it can be written.

| type | why | the question |
|---|---|---|
| `aws_db_instance`, `aws_rds_cluster` | SQL over TCP, not HTTP | ship a driver in the package, or leave databases to the container runtime? |
| `aws_elasticache_replication_group` | Redis wire protocol over TCP | same question, and no serverless runtime can open a raw socket |
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
