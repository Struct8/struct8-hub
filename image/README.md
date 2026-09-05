# image

`index.mjs` is Hub, built for the container runtime, and `Dockerfile` beside it turns the folder
into an image. One file, every AWS resource, no dependencies.

```
base      node:22-alpine
entry     node index.mjs
port      8080
size      53 KiB
```

## Why this is a folder and not a Dockerfile somewhere else

The build context is this folder, and everything the build copies is in the tree. A clean clone
builds:

```bash
docker build -t struct8-hub image
```

The Dockerfile this replaces copied `build/index.mjs`, which `.gitignore` excludes. It built on the
machine that had just run the bundler, and nowhere else — including every CI runner and every
CloudMan apply, both of which start from a clean clone.

## Using it in a CloudMan template

Wire the `cldmn_github` node to the `aws_ecr_repository` node and set the repository's **image
path** to `image`. The pipeline sparse-checks out that folder, the generated `null_resource` builds
it and pushes it to the repository, and the ECS task pulls from there.

The tag is not configured twice: whatever the container's `image` field asks for is what gets
pushed.

## It differs from `prebuilt/` in one line

Same code, different entry point. `prebuilt/index.mjs` exports a handler and waits to be called;
this one calls `container()` and starts listening. A function artifact in a container starts, exits
immediately, and ECS restarts it forever with nothing in the log to explain it.

## It is generated

Do not edit it here. Change the source, then:

```bash
npm run prebuilt:image
```

`npm test` refuses to pass while this file and the source disagree.
