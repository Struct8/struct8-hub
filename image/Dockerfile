# The image for the container runtime.
#
# The build context is this folder and nothing else. `index.mjs` beside it is the artifact, in
# the tree, so a clean clone builds:
#
#     docker build -t struct8-hub image
#
# That property is the whole reason this folder exists. The previous Dockerfile copied
# `build/index.mjs`, which `.gitignore` excludes -- it built on the machine that had just run the
# bundler and nowhere else, and a CloudMan diagram that points ECR at this repository is a clean
# clone every time.
#
# Rebuild the artifact after changing the source:
#
#     npm run prebuilt:image
#
# Credentials are not passed in and must not be: on ECS the task role arrives through the
# container credential endpoint, which the runtime reads and refreshes on its own.

FROM node:22-alpine

# Never root. The task role is the only privilege this needs, and a compromised process that also
# owns the filesystem is a larger problem than the one it started as.
USER node
WORKDIR /app

COPY --chown=node:node index.mjs ./index.mjs

# The default the runtime listens on. It must match `containerPort` in the task definition and the
# port on the target group -- a mismatch fails the health check, and ECS then replaces the task
# every few minutes with nothing in the log to say why.
EXPOSE 8080

# Straight to node, no shell wrapper: PID 1 has to be the process that handles SIGTERM, or ECS
# waits out StopTimeout and kills the container mid-request on every deployment.
CMD ["node", "index.mjs"]
