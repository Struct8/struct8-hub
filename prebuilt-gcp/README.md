# prebuilt-gcp

`index.mjs` is Hub, built for Google Cloud Functions (2nd gen). One file, every resource, no
dependencies.

```
runtime      nodejs22
entry point  handler
```

`package.json` names `index.mjs` as the module to load and declares it an ES module. It declares
no dependency: Cloud Functions installs the Functions Framework, which calls `handler`, when it
builds the function ("Although Cloud Run functions installs it on your behalf when the function
is created", in Google's page on Node.js dependencies).

## Using it in a CloudMan diagram

1. Connect a GitHub component pointing at `Struct8/struct8-hub` to the function.
2. Fill in the function's File Path with `prebuilt-gcp`.
3. Set the runtime to `nodejs22` and the Entry Point to `handler`.

The generator zips this folder and uploads it to the function's code bucket. Each outgoing
connection of the function becomes an environment variable (`CONTRACT.md`), and its grant label
gives the function's service account the role the destination needs.

## It is generated

Do not edit `index.mjs` here. Change the source, then:

```bash
npm run prebuilt:gcp
```

`npm test` refuses to pass while this file and the source disagree.
