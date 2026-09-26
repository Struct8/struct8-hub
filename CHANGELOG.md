# Changelog

Notable changes to `@struct8/hub`. The **wiring contract** carries its own version, independent of
this package's — a package release does not imply a contract change, and a contract change is
always called out here explicitly.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing is published yet. The core runs and is tested; nothing has been executed against a live
AWS account.

### Added

- Wiring contract v1, documenting the environment-variable grammar as the generator emits it
  today, including the two gaps it does not yet cover: no incoming side, and the retired
  `TARGET_` format.
- Architecture: four ports, one rule (the core imports no cloud SDK), and the seams held open for
  cross-provider work.
- Core: `discovery`, `envelope`, `registry`, `report`, `hub`. 28 tests, no network.
- AWS transport over signed `fetch` (`aws4fetch`), with signing kept separate from sending so a
  sender can be exercised with a fake `fetch` — and so the identity port has somewhere to attach.
- Every applicable AWS resource: 18 modules covering 14 send targets and 12 event sources. The
  candidate set was derived from the catalog rather than estimated — see `docs/coverage.md`.
- Conformance suite that iterates the registry, so a new resource is tested without anyone writing
  a test for it.
- Contract test against real generator output, captured from compiled diagrams rather than
  invented (`test/fixtures/generator-output.json`, recaptured by
  `scripts/capture-contract-fixture.mjs`). Every captured name must be classified as base, wired,
  or ignored-with-a-reason; an unclassified one fails the suite, because the default behaviour for
  an unclassified type is the silence this package exists to remove.
- Live protocol probe (`scripts/probe-aws.mjs`), read-only, covering all eleven service/protocol
  pairs. 168 tests offline.
- AWS Lambda runtime.
- `image/`: the container artifact and its `Dockerfile` in one folder, so `docker build image`
  works from a clean clone. The Dockerfile it replaces copied `build/index.mjs`, which
  `.gitignore` excludes — it built on the machine that had just run the bundler and nowhere else,
  including every CI runner and every CloudMan apply. `npm run prebuilt:image` rebuilds it, and
  the suite fails while it and the source disagree. The artifact differs from `prebuilt/` in one
  line: it calls `container()` instead of exporting a handler, and a function artifact in a
  container starts, exits, and is restarted forever with nothing in the log to say why — so that
  line is asserted too.
- Container runtime for ECS (`src/runtimes/container.ts`), plus `image/Dockerfile` and a
  `--runtime container` mode in the bundler. Two things differ from Lambda and nothing else does:
  work arrives over HTTP, and the task role is fetched from the container credential endpoint and
  refreshed ahead of expiry — reading it once at startup produces a container that works all
  morning and starts failing after lunch. `GET` is the health check and never forwards, because a
  target group calls it every thirty seconds. A failed hop answers 200 carrying the report rather
  than 5xx, so a correctly reported failure is not read by the load balancer as a broken task.
  Verified by running the built artifact against a simulated credential endpoint: AWS rejected the
  fake key, which is the proof that the fetched credentials reached the signer.
- Queue consumption for runtimes AWS does not poll on their behalf: a `consume` port on
  `ResourceModule`, implemented by `aws_sqs_queue`, and a poll loop in the container runtime. The
  receipt handle never leaves the resource module — `ack` is a closure the module builds, because
  the handle is not the message id and nothing else has any use for it. Only the items whose
  fan-out succeeded are deleted; an item that ran out of hops *is* deleted, since redelivering it
  would drop it again forever.
- `HUB_POLL`, naming which wired neighbor to read. It exists because the contract has no incoming
  side: the wire that makes a queue discoverable is drawn outward, so its direction cannot say
  whether it is an input or a destination. The source is excluded from its own fan-out — without
  that, every message read is written straight back, and only the hop budget stops it. The variable
  is a stopgap and CONTRACT.md §8.1 says why it is still wrong.
- README and getting-started guide in English and Brazilian Portuguese.
- Load-test endpoint on the container runtime (`POST /loadtest?ms=N`), off by default and enabled
  only with `HUB_LOADTEST`. It spends about `N` milliseconds of CPU (clamped to 10 s) and returns
  how long it took. It exists for the educational autoscaling templates: a target whose CPU cost
  per request is a knob, so a scaling policy can be watched reacting to load the generator
  controls precisely. It is deliberately outside the wiring contract — it discovers nothing, fans
  out to nothing, and touches no report — and it lives on its own path, so `GET` health and the
  `POST /` fan-out are unchanged whether it is on or off. Off is a 404, not a 405: to anyone
  probing, a CPU-burn route that was never asked for simply does not exist.
- X-Ray tracing. The report already measured every hop; it now also goes up as segments, so the
  console shows one trace across a chain instead of one per resource. Three parts, and each exists
  because the other two cannot do its job: the correlation id in the envelope is minted in X-Ray's
  trace format instead of as a UUID (a UUID correlates the logs perfectly and X-Ray rejects it), the
  `X-Amzn-Trace-Id` header rides every signed request (which is what SNS, API Gateway and Step
  Functions read — a topic never opens the message body), and SQS sends carry the trace in the
  `AWSTraceHeader` message system attribute (the one hop no header reaches, because the sender and
  the consumer never speak to each other). `Hop` gained `at`, the absolute start: a duration alone
  cannot be placed on a timeline.
  On Lambda there is no switch — `_X_AMZN_TRACE_ID` already carries the platform's decision, and
  `Sampled=0` means nothing is sent and nothing signed changes. A container has no such signal, so
  it takes `HUB_TRACE`; recording by default would begin charging X-Ray on every task that pulled a
  new image. Subsegments hang off the invocation segment on Lambda and off a segment the run writes
  itself in a container — writing one in both places shows the function twice, writing it in neither
  is accepted by the API and never displayed. The execution or task role needs
  `xray:PutTraceSegments` and `xray:PutTelemetryRecords`; without them the fan-out is unaffected and
  the reason is logged, because telemetry failing is not the work failing.

### Fixed

- Behind an API Gateway REST proxy integration, every request answered `502 Internal server
  error`. The Lambda runtime returned the report on its own, and a payload-format-1.0 proxy
  integration refuses any answer without `statusCode`. Nothing on the function's side showed it —
  the invocation succeeded, the report printed, the duration was normal — so the symptom read as a
  broken deployment rather than as a missing field. An arrival from `aws:apigateway` or
  `aws:lambda_url` now comes back as `{ statusCode, headers, body }` with the report serialized
  into the body. Reported from a live deployment, not caught by the suite, which had no test for
  the Lambda runtime's return value at all; `test/lambda.test.ts` now covers it.

  The status is **200 even when a wire failed**, which is the answer the container runtime already
  gives: the report is the result, and `hops[].ok` carries the per-wire truth. A 502 is also what
  the gateway itself returns when the integration is wrong, so spending it on a reported failure
  would make a working Hub with one bad destination read exactly like a Hub that was deployed
  wrong. Note for anyone revisiting this: `report.failed` cannot carry the signal, because it only
  takes items that have an `id` and an HTTP arrival has none — a status derived from it answers
  200 always.

- The queue and topic senders composed a target URL and ARN with an empty segment when the wire
  carried no `NAME`, and sent to it. Both were valid strings, so nothing complained locally; the
  answer from AWS would have been an error about a resource that does not exist, a long way from
  *the wire carried no name*. Found by the conformance suite on its first run, against code that
  had already been reviewed by hand.

### Notes

- Loop control is a hop counter carried in the envelope, replacing the substring check the
  predecessor used. That check suppressed legitimate messages mentioning the workload's own name,
  and — because a suppressed item was not reported as failed — let a batched source advance its
  checkpoint past a record nobody processed.
- The account id is recovered from the invocation ARN. The generator emits `ACCOUNT` only for
  resources in a *different* account, and AWS publishes it in no variable of its own, so on the
  ordinary path every composed SQS URL would otherwise come out malformed.

### Next

- A first run against a real diagram.
- Container runtime, once the contract has an incoming side.
- Cloudflare Workers runtime.
