# Getting started

**English** · [Português](getting-started.pt-BR.md)

> **The code runs; this flow has not been driven from a diagram yet.** The core, every applicable
> AWS resource and the Lambda runtime are done and have been invoked against a live account. What
> has not happened is a deploy where the generator writes the wiring — the environment has been
> supplied by hand so far. Steps 1 and 2 below are therefore the part still to be proven.
>
> `@struct8/hub` is not on npm, and does not need to be: `node scripts/bundle.mjs` produces a
> self-contained zip with no dependencies.

---

## What you will have in five minutes

A diagram with three nodes and two wires, deployed, sending a message end to end, and a report
that tells you which wire carried it.

```
  ┌──────────┐        orders        ┌──────────┐
  │  Queue   │ ───────────────────▶ │ Function │
  └──────────┘                      └────┬─────┘
                                         │ archive
                                         ▼
                                   ┌──────────┐
                                   │  Bucket  │
                                   └──────────┘
```

## 1. Draw it

In Struct8: a queue, a function, a bucket. Wire the queue into the function, and the function into
the bucket. Label the second wire `archive` — the label becomes part of the report, and it is how
you tell two wires to the same target apart.

Nothing else. No code, no permissions, no environment variables. Those are what the wires are for.

## 2. Deploy

The generator emits the infrastructure and fills the function with a file that looks like this:

```js
import { hub } from '@struct8/hub';
import '@struct8/hub/r/aws_sqs_queue';
import '@struct8/hub/r/aws_s3_bucket';

export const handler = hub.lambda();
```

You do not write this file, but it is worth reading once. The two resource imports are exactly the
two types in your diagram — nothing else ships. There is no list of destinations: the function
finds the bucket by reading its own environment, which the generator filled from the wire.

## 3. Send something

Put a message on the queue.

## 4. Read the report

```json
{
  "trace": "01JQ8F2K7VN3",
  "origin": "aws:sqs",
  "hops": [
    { "n": 1, "to": "my-archive-bucket", "type": "aws_s3_bucket",
      "label": "archive", "ok": true, "ms": 41 }
  ]
}
```

One line per wire the message actually crossed. `label` is the text you typed on the wire, which
is how this maps back to the picture you drew.

A failure is reported, not thrown:

```json
{ "n": 1, "to": "my-archive-bucket", "type": "aws_s3_bucket",
  "label": "archive", "ok": false, "ms": 12,
  "err": "AccessDenied: s3:PutObject" }
```

The other destinations still receive their copy. One broken wire does not take the rest down.

## What to try next

**Add a second wire from the function to the same bucket**, labelled differently. Both fire. The
diagram drew two wires, so two things happen — that is the rule, and it is occasionally surprising
until you have seen it once.

**Delete a wire and redeploy.** The destination disappears from the report without anyone editing
code. The wire is the configuration; there was never a list to update.

**Break something on purpose.** Remove the bucket's permission and send again. The report names
the wire and the reason. This is the mode the tool is actually for: not proving that a working
diagram works, but finding out quickly which part of a broken one doesn't.

## Where the wiring is written down

Everything above rests on one agreement between the generator and the code: how a wire becomes an
environment variable. That is [CONTRACT.md](../CONTRACT.md), it is versioned, and it is
independent of this implementation — if you would rather write your own hub, that document is all
you need.
