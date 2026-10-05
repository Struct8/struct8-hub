# Hub

**English** · [Português](README.pt-BR.md)

Hub is the code that runs *inside* the resources you draw.

You draw a diagram — a function, a queue, a bucket, a wire between them. Struct8 generates the
infrastructure. Hub is what fills the compute: it discovers every resource it was wired to,
forwards whatever arrives to all of them, and reports each hop so you can watch the diagram work.

**There is no list of destinations in the code.** The wire is the configuration.

```js
import { hub } from '@struct8/hub';
import '@struct8/hub/r/aws_sqs_queue';
import '@struct8/hub/r/aws_s3_bucket';

export const handler = hub.lambda();
```

That is the whole generated file. Everything else is versioned in the package.

---

## Status

**Pre-release: not on npm, and not versioned yet.** The AWS side is complete and has been run
against a live account. Nothing here has been applied from a diagram.

| piece | state |
|---|---|
| [Wiring contract](CONTRACT.md) v1 | documented, matches what the generator emits today |
| Core (`discovery`, `envelope`, `registry`, `report`) | done, 28 tests (391 in the suite) |
| AWS resources | done: 24 modules, 20 send targets, 12 event sources ([coverage](docs/coverage.md)) |
| AWS Lambda runtime | done, invoked end to end against a live account |
| Deployable bundle | done: `node scripts/bundle.mjs` produces a 293 KiB zip |
| Container runtime (ECS) | done: HTTP in, task-role credentials, SQS consumption behind `HUB_POLL` ([why a variable](CONTRACT.md#known-gaps)) |
| Cloudflare Workers runtime | planned |

**A built file is in the repository: [`prebuilt/index.mjs`](prebuilt/index.mjs)** — one file,
every AWS resource, no dependencies, `nodejs22.x` / `index.handler`. Take it as it is, or build a
smaller one.

**You do not need npm to run this.** `scripts/bundle.mjs` inlines the core, the resources your
diagram uses and the request signer into one file, so a function carries no dependencies at all:

```
node scripts/bundle.mjs --resources aws_sqs_queue,aws_s3_bucket
# build/hub.zip -- handler index.handler, runtime nodejs22.x
```

What has *not* happened: a deploy driven by a CloudMan diagram. The environment variables have
been fed to the handler by hand, matching what the generator emits, and it reached AWS correctly.
Proving the generator's real output against this parser is the next step.

Cross-provider wiring (a Lambda writing to R2, a Worker reading from SQS) is **out of scope for
now** and deliberately not designed around. The [architecture](docs/architecture.md) explains
which seams were left open so it can arrive later without a rewrite.

## Use it in a CloudMan template

Terraform zips a *directory* at apply time, so the code is a file in a folder — no npm install, no
S3 upload, no build step.

1. Take [`prebuilt/index.mjs`](prebuilt/index.mjs).
2. Put it at `CloudMan-Templates/LambdaFiles/<logical name of the Lambda node>/index.mjs`.
3. Set the function to `nodejs22.x`, handler `index.handler`.

**The folder name must equal the node's logical name.** That is what composes `source_dir` in the
generated `archive_file`; a mismatch produces an empty archive and a function that will not start.

Then wire the function to whatever it should reach. Nothing else: no destination list to maintain,
no code to write. Hub reads the wires out of its own environment and reports what each one did —
which target, how long, and the reason when one fails.

Details, and how to build a smaller file, in [prebuilt/README.md](prebuilt/README.md).

## Run it on ECS

The same code, one build flag apart. A function is invoked; a process has to be reachable, so the
container answers HTTP — and it reads the task role from the ECS credential endpoint, refreshing it
before it expires, because ECS does not put credentials in the environment the way Lambda does.

```
npm run prebuilt:image
docker build -t struct8-hub image
```

The build context is `image/`, and the artifact it copies is committed there, so a clean clone
builds — which is what a CloudMan template applying in somebody else's account is. Details in
[image/README.md](image/README.md).

Wire the ECS box to whatever it should reach, put a load balancer in front of it, and `POST`
anything to the task. **The report comes back in the response** instead of going to CloudWatch,
which is the fastest way to see whether a diagram is wired the way it was drawn.

`GET` is the health check and never forwards — a target group calls it every thirty seconds, so a
health check that fanned out would fire the whole diagram twice a minute and bill for every hop.
The port defaults to 8080 and must match both `containerPort` and the target group.

**Consuming a queue** takes one variable, and it is a stopgap with a reason. The generator emits
only the wires that *leave* a node, so a queue drawn as pointing at this workload produces nothing
to discover ([the gap](CONTRACT.md#known-gaps)). Draw it the other way — from the ECS box to the
queue — and name that wire's label:

```
HUB_POLL=in
```

The permission is already correct: the policy a queue wire generates grants `ReceiveMessage` and
`DeleteMessage` alongside `SendMessage`. What is wrong is the arrow, and `HUB_POLL` is what says
which of a wire's two possible meanings this one carries. The source is excluded from its own
fan-out, so a message is never written back to the queue it came from, and only the messages that
were actually forwarded are deleted. When the generator emits source-side variables, the variable
stops being necessary.

Streams are deliberately not consumable. Shards, iterators, checkpoints and lease coordination
between tasks are a different job, and doing it badly produces silence or reprocessing rather than
an error.

## Load-test endpoint (educational, off by default)

For the Struct8 autoscaling templates there is a second route on the container runtime whose only
job is to spend CPU on demand, so a scaling policy can be watched reacting to load a generator
controls precisely:

```
HUB_LOADTEST=on
POST /loadtest?ms=200
```

It burns about `ms` milliseconds of CPU (capped at 10 s) and answers with how long it actually
took. It is **off unless `HUB_LOADTEST` is set** — an endpoint that burns CPU on demand is a
denial-of-service vector if it answers by default in an account that never asked for it, so while
it is off the path is a 404, as if it did not exist.

It is deliberately not part of the wiring contract: it discovers no neighbor, fans out to nothing,
and touches no report. It lives on its own path, so the `GET` health check and the `POST /`
fan-out behave exactly the same whether it is on or off. Point k6 at `POST /loadtest?ms=...`
through the load balancer, and the ASG scales on the CPU each request costs — a cost you set.

## Tracing (X-Ray)

The report can go to X-Ray as well as to the log. Each hop becomes one subsegment — the target's
name, how long it took, the reason when it failed — and the trace carries on to the next workload,
so a request crossing four resources is one trace in the console instead of four.

**On Lambda there is nothing to switch on.** The runtime reads `_X_AMZN_TRACE_ID`, which AWS sets on
every invocation, and follows it: `Sampled=1` when the invocation is being traced, `Sampled=0` when
it is not. A function that is not traced sends no segments and signs exactly the requests it signed
before.

**In a container, set `HUB_TRACE`.** ECS has no tracing setting to read, so there is nothing to
consult, and recording by default would start charging X-Ray on every task that pulled a new image.

```
HUB_TRACE=on
```

**Permission:** the execution role on Lambda, the task role on ECS, needs `xray:PutTraceSegments`
and `xray:PutTelemetryRecords`. Without them the fan-out still happens and the log carries
`trace not sent: AccessDenied` — telemetry failing is not the work failing.

**Important:** X-Ray sampling rules do not apply. Segments go up through `PutTraceSegments`, which
records what it is handed; a sampling rule governs the decision a client SDK makes, and there is no
client SDK here — the transport is signed `fetch`. What decides is `Sampled` on Lambda and
`HUB_TRACE` in a container.

Two things carry the trace onward, and both are needed:

| hop | what carries it |
|---|---|
| a service that keeps traces of its own — SNS, API Gateway, Step Functions, a Lambda invoke | the `X-Amzn-Trace-Id` header on the signed request |
| a queue, for whatever consumes it later | SQS's `AWSTraceHeader` message system attribute |

The second is the one no header can do: the sender and the consumer never speak to each other, so
the trace travels with the message. An event source mapping reads that attribute and opens the
consumer's invocation under the same trace, which is what joins two functions into one.

## How it works

**Discovery.** The generator injects one environment variable per wire, named after the target's
type, the value it carries, and the wire's own label. Hub parses those names and rebuilds the
neighbor list. Nothing is hard-coded, and a wire the diagram doesn't have cannot be reached.

**Normalization.** Whatever triggered the workload — a queue batch, an object created, an HTTP
request, a stream record — is reduced to a list of items plus a description of where they came
from. One shape for every event source.

**Fan-out.** Each neighbor is looked up in the registry and handed the message. One small
function per resource type; the core never learns their names.

**Report.** Every hop produces a line: which wire, which target, how long, and what failed. That
report is the point — it is what tells you the diagram is wired the way you drew it.

## Documentation

| | |
|---|---|
| [Getting started](docs/getting-started.md) | first run, five minutes |
| [prebuilt/index.mjs](prebuilt/index.mjs) | the built file, and where it goes in a template |
| [CONTRACT.md](CONTRACT.md) | the wiring contract — read this to write your own Hub |
| [Architecture](docs/architecture.md) | the four ports, and why they are cut where they are |
| [Coverage](docs/coverage.md) | what Hub can reach, what it cannot, and why |
| [Adding a resource](docs/adding-a-resource.md) | one folder, one file, no core changes |

The contract is versioned and independent of this implementation. If you would rather write your
own hub in your own language, [CONTRACT.md](CONTRACT.md) is all you need — that is on purpose.

## License

[Apache 2.0](LICENSE).
