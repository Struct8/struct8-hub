# The image for the container runtime.
#
# The artifact is one file with no dependencies, so there is nothing to install and no reason for a
# build stage here — bundle first, copy second:
#
#     node scripts/bundle.mjs --runtime container --raw --out build/index.mjs
#     docker build -f docker/Dockerfile -t struct8-hub .
#
# Credentials are not passed in and must not be: on ECS the task role arrives through the container
# credential endpoint, which the runtime reads and refreshes on its own.

FROM node:22-alpine

# Never root. The task role is the only privilege this needs, and a compromised process that also
# owns the filesystem is a larger problem than the one it started as.
USER node
WORKDIR /app

COPY --chown=node:node build/index.mjs ./index.mjs

# The default the runtime listens on. It must match `containerPort` in the task definition and the
# port on the target group — a mismatch fails the health check, and ECS then replaces the task
# every few minutes with nothing in the log to say why.
EXPOSE 8080

# Straight to node, no shell wrapper: PID 1 has to be the process that handles SIGTERM, or ECS
# waits out StopTimeout and kills the container mid-request on every deployment.
CMD ["node", "index.mjs"]
