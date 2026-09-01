# prebuilt

`index.mjs` is Hub, built. One file, every AWS resource, no dependencies — the artifact a template
takes when there is no Node toolchain in the way.

```
runtime   nodejs22.x
handler   index.handler
size      44 KiB
```

## Using it in a CloudMan template

Terraform zips a *directory* at apply time, from
`.external_modules/LambdaFiles/<logical name of the Lambda node>`. So:

```
CloudMan-Templates/LambdaFiles/<logical name>/index.mjs
```

**The folder name must equal the node's logical name.** That is what composes `source_dir`; a
mismatch produces an empty archive and a function that fails to start.

## It is generated

Do not edit it here. Change the source, then:

```bash
npm run prebuilt
```

`npm test` refuses to pass while this file and the source disagree — a committed artifact that
drifts from its source is worse than no artifact, because whoever fetched it runs one thing while
reading about another.

## Trimming it

Every resource is included so that any diagram works without a rebuild. On AWS that costs nothing.
Where bundle size is capped, build only what the diagram uses:

```bash
node scripts/bundle.mjs --raw --resources aws_s3_bucket,aws_sqs_queue,aws_sns_topic
```
