# Adding a resource

One folder. One file. The core does not change.

If you find yourself editing anything under `src/core/` to support a new resource type, the
abstraction is wrong and the fix belongs there, not in a special case.

---

## The module

```
src/resources/aws_sns_topic/index.ts
```

```ts
import { register } from '../../core/registry.js';
import { aws } from '../../providers/aws.js';

register({
  type: 'aws_sns_topic',
  capabilities: ['topic'],

  async send(n, envelope, ctx) {
    const arn = n.props.ARN ?? `arn:aws:sns:${ctx.region(n)}:${ctx.account(n)}:${n.props.NAME}`;
    await aws(ctx).sns.publish({ TopicArn: arn, Message: envelope.body });
  },

  receive(raw) {
    const r = (raw as SnsEvent).Records[0].Sns;
    return {
      origin: 'aws:sns',
      describe: `SNS ${r.TopicArn.split(':').pop()}`,
      items: [{ body: r.Message }],
    };
  },
});
```

Then add the line to the barrel:

```bash
npm run gen:registry
```

That is the whole change.

## The fields

| field | required | what it does |
|---|---|---|
| `type` | yes | the catalog type. Also feeds the parser's type vocabulary — see [CONTRACT.md §2](../CONTRACT.md#2-parsing-is-by-vocabulary-not-by-pattern) |
| `keys` | no | grammar keys beyond the common ones, e.g. `['QUEUE_URL']`. Feeds the key vocabulary |
| `capabilities` | no | what kind of thing this is: `queue`, `topic`, `object-store`, `stream`, `table`, `http` |
| `send` | no | how to forward a message to it. Omit for a resource that can only be a source |
| `receive` | no | how to read an event that came *from* it. Omit for a resource that can only be a target |

A module with neither `send` nor `receive` is rejected at registration. A neighbor that can be
discovered but never reached is the silent failure this design exists to prevent.

## Rules that the conformance suite enforces

You do not write tests for these. The suite iterates the registry and applies them to every
registered module.

**Never throw for a missing value.** A neighbor may arrive without `ARN`, without `REGION`,
without anything but `NAME`. Fall back, or record a failed hop with a readable reason. A thrown
exception takes down the other destinations with it.

**Record exactly one hop per attempt**, success or failure. A destination that succeeds silently
is a wire the diagram cannot color.

**Do not read the environment.** Everything you need is in the `Neighbor` or in `ctx`. Reading
`process.env` directly makes the module untestable and breaks on Workers, where there is no
`process`.

**Do not import a cloud SDK at module scope.** Import inside `send`, or take it from `ctx`. A
top-level import is paid by every deployment that includes this file, whether or not the diagram
uses it.

**Be idempotent under retry.** Batched sources redeliver. A module that appends without a key
turns one redelivery into a duplicate that is indistinguishable from a real second message.

## Declaring a new grammar key

If the generator emits a value this resource needs, and no existing key carries it, declare it:

```ts
register({
  type: 'aws_db_instance',
  keys: ['ENDPOINT', 'DB_NAME', 'USER_NAME'],
  ...
});
```

Then add it to the table in [CONTRACT.md §3](../CONTRACT.md#3-known-keys). The contract is what
other implementations read; a key that exists only in code is a key that only this implementation
understands.

Keys are matched longest-first, so a new key that is a suffix of an existing one — `NAME` and
`USER_NAME` — resolves correctly without any ordering work on your part. A new key that is a
*prefix* of an existing one is the case to think twice about.

## Cross-provider senders

Not yet. `send` currently assumes the workload and the target are in the same provider, and
identity comes from the runtime's ambient credentials.

When the identity port lands, `ctx` gains a signer and the same `send` covers the cross-provider
case with no change to this file — which is the reason the credential was never passed as an
argument in the first place. Write against `ctx`, not around it.
