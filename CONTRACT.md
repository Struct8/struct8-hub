# Wiring contract

**Version 1** · applies to AWS · English only (this document changes with every contract revision)

This is the agreement between the generator that emits infrastructure and the workload that runs
inside it. The generator turns each wire in the diagram into one or more environment variables;
the workload reads its own environment and rebuilds the list of resources it was connected to.

The contract is the product. An implementation of Hub is one way to consume it — you can write
your own, in any language, against this document alone.

---

## 1. The grammar

Every wire-derived variable has three segments:

```
<TYPE>_<KEY>_<LABEL>
```

| segment | comes from | example |
|---|---|---|
| `TYPE` | the target's resource type, non-alphanumerics replaced by `_`, uppercased | `aws_sqs_queue` → `AWS_SQS_QUEUE` |
| `KEY` | which value this variable carries | `NAME`, `ARN`, `URL`, `QUEUE_URL` |
| `LABEL` | the wire's own text in the diagram, stripped of everything outside `[A-Za-z0-9_]` | `orders` → `ORDERS` |

```
AWS_SQS_QUEUE_NAME_0        = "OrdersQueue"
AWS_S3_BUCKET_NAME_ARCHIVE  = "my-archive-bucket"
AWS_DYNAMODB_TABLE_ARN_0    = "arn:aws:dynamodb:us-east-1:123456789012:table/Events"
```

A wire with no text gets the label `0`. The label is never empty: a variable ending in `_` is
malformed and must be ignored rather than guessed at.

## 2. Parsing is by vocabulary, not by pattern

This is the part that is easy to get wrong, so it is spelled out.

```
AWS_LAMBDA_FUNCTION_URL_NAME_0
```

Two splits are syntactically valid — `AWS_LAMBDA_FUNCTION` + `URL_NAME_0`, and
`AWS_LAMBDA_FUNCTION_URL` + `NAME_0` — and only the second is correct. No regular expression can
choose between them, because both `AWS_LAMBDA_FUNCTION` and `AWS_LAMBDA_FUNCTION_URL` are real
types, and both `NAME` and `URL_NAME` look like plausible keys.

The resolution is to match against **known vocabularies, longest first**:

1. find the longest known `TYPE` that the variable name starts with, followed by `_`
2. in the remainder, find the longest known `KEY` that it starts with, followed by `_`
3. whatever is left is the `LABEL`

A name that fails either step is not part of this contract and must be ignored silently — the
environment also holds variables that have nothing to do with wiring.

The vocabularies must be **derived from the set of resources the implementation supports**, never
written by hand in a second place. A type that is recognized by the parser but has no way to be
reached is a silent failure: the variable parses, a neighbor appears, and nothing happens.

## 3. Known keys

| key | carries |
|---|---|
| `NAME` | the target's logical name — the fallback, always present when nothing else is declared |
| `ARN` | full ARN |
| `URL` | a URL |
| `ID` | an opaque identifier |
| `BUCKET` | bucket name |
| `PATH` | a filesystem path (EFS access points) |
| `ENDPOINT` | host, or `host:port` |
| `QUEUE_URL` | SQS queue URL |
| `SECRET_ARN` | Secrets Manager ARN |
| `USER_NAME` | database user |
| `DB_NAME` | database name |
| `ENGINE` | the database engine, as the provider names it: `postgres`, `mysql`, `aurora-postgresql` |
| `ENGINE_FAMILY` | the protocol an RDS Proxy speaks, as the provider names it: `POSTGRESQL`, `MYSQL`, `SQLSERVER` |
| `PORT` | the port to connect to, where `ENDPOINT` is the host alone (an RDS Proxy) |
| `REGION` | the target's region — **emitted only when it differs from the source's** |
| `ACCOUNT` | the target's account — **emitted only when it differs from the source's** |

New keys come from the target's own resource definition. A target that declares nothing gets
`NAME` alone, carrying its logical name.

`ENGINE_FAMILY` starts with `ENGINE`, and §2 reads the longer key first. The cost is a variable of
an instance whose label starts with `FAMILY_`, which is read as a family too.

Note the consequence of the two conditional keys: **absence means "same as mine"**, not "unknown".
A consumer that treats a missing `REGION` as an error will break on the common case.

## 4. Values

A value is a string.

> **Reserved for v2.** On platforms where a resource is delivered to the workload as a live object
> rather than an identifier — Cloudflare Workers bindings, for instance — the key `HANDLE` carries
> that object instead of a string. The grammar is unchanged; only the value's type differs. This
> is not emitted today and consumers need not support it yet, but the key is reserved so that
> nothing else claims it.

## 5. Identity and merging

A neighbor is identified by the pair **(`TYPE`, `LABEL`)**, not by the variable name. Several
variables describing the same target merge into one neighbor:

```
AWS_SQS_QUEUE_NAME_ORDERS   = "OrdersQueue"
AWS_SQS_QUEUE_REGION_ORDERS = "eu-west-1"
```

is one neighbor of type `AWS_SQS_QUEUE`, label `ORDERS`, with two values.

Two wires to the same target with different labels are **two neighbors**, and both must receive
the message. This is deliberate: the diagram drew two wires, so two things should happen.

Ordering must not depend on the environment's iteration order. Sort by label.

## 6. Variables about the workload itself

These are not wire-derived and have no `TYPE_KEY_LABEL` shape:

| variable | value |
|---|---|
| `NAME` | the workload's own logical name |
| `REGION` | the region it runs in |
| `ACCOUNT` | the account it runs in |
| `CICD_STAGE` | pipeline stage name, when the diagram is staged |
| `CICD_VERSION` | pipeline version, when the diagram is staged |

`ACCOUNT` is emitted by the generator **only when a resource lives in a different account**, and
AWS publishes the account id in no environment variable of its own. On the common path this
variable is absent, and any consumer that composes an SQS URL or an SNS ARN from it will produce
`.../None/queue-name` and fail every send. Recover it from the invocation's own ARN instead.

## 7. What the generator emits, and what it does not

Variables are emitted for a workload when its resource type is marked as an environment-variable
consumer. As of contract v1 that is `aws_lambda_function`, `aws_instance`,
`aws_ecs_task_definition` and `aws_launch_template`.

Only **outgoing** wires produce variables — those leaving the workload's node.

A wire that passes through an IAM policy node is followed to the resource on the far side: the
policy is transparent, and the variable describes the real target.

No variable is emitted for: internal `cldmn_*` types, container-marker types whose name ends in
`_`, or a launch template pointing at itself.

## 8. Known gaps

Recorded here because a contract that hides its holes is worse than one that names them.

<a name="known-gaps"></a>

### 8.1 There is no incoming side

The contract describes what a workload can **send to**, never what it should **listen to**.

On AWS Lambda this is invisible, because the incoming edge is realized by the platform: an event
source mapping, an S3 notification, an API Gateway integration. The function is called; it never
had to know who called it.

A container or a virtual machine has no such platform. It must poll — and nothing in the
environment tells it what to poll. Closing this properly means emitting the source side as well,
which is a generator change.

**The container runtime works around it, and the workaround is worth understanding as evidence of
the cost.** A queue wired *outward* is emitted, and the policy that wire generates already grants
`ReceiveMessage` and `DeleteMessage` alongside `SendMessage` — so the capability is present and
only the meaning is missing. `HUB_POLL` names which wire to read instead of write. That works, and
it is still wrong in the place that matters: the arrow on the diagram points away from the workload
while the data flows towards it, so the drawing says the opposite of what runs. A contract whose
consumers have to be told which direction a wire really means has not described the wire.

Even where the workload does not need it to run, it needs it to *report*: saying "this wire exists
and was never exercised" requires knowing the wire exists.

### 8.2 The retired format

An earlier revision placed a direction segment in the middle:

```
AWS_S3_BUCKET_TARGET_NAME_0     ← no longer emitted
```

It is not part of this contract and must not be parsed. Any consumer still reading it predates
this document and is discovering nothing.

## 9. Conformance

An implementation conforms if, given the environment block of a compiled diagram, it produces
exactly the neighbor set that the diagram's outgoing wires describe — same types, same labels,
same values, ignoring order.

The suite that proves this must run against **real generator output**, not hand-written fixtures.
A hand-written fixture agrees with whoever wrote it; only real output disagrees when the generator
changes. The retired format in §8.2 is the cautionary case: it left the generator, and the
consumers that still read it kept passing their own tests.

In this implementation that is `test/contract.test.ts`, running against names captured from
compiled diagrams — `test/fixtures/generator-output.json` records which files they came from and
when. `node scripts/capture-contract-fixture.mjs <checkout>` recaptures and reports the drift.

Every captured name must be classified, and the classification is the point:

- **base** — describes the workload itself (`NAME`, `REGION`, `ACCOUNT`) and must never become a
  neighbor. Reading these as wires would give every workload three phantom destinations.
- **wired** — a resource this implementation reaches.
- **ignored** — a resource it does not, *with the reason written down*. `AWS_SUBNET_NAME_0` is
  emitted by the generator and means nothing to a message; `AWS_EFS_FILE_SYSTEM_ID_0` means
  something and is blocked on a decision. Both are silence, and only the recorded reason
  distinguishes a decision from an oversight.

A name that fits none of the three fails the suite. That is deliberate: the default behavior for
an unclassified type is exactly the failure this contract exists to prevent — the wire is drawn,
the variable is written, and nothing happens.
