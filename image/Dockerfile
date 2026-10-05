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

# The Amazon RDS certificate authorities, which issue the certificate of every RDS database, Aurora
# cluster and DocumentDB cluster. Node does not trust them by default, so without them a connection
# to any of those fails to verify. NODE_EXTRA_CA_CERTS is read when the process starts and ADDS the
# file to the authorities Node already trusts, which is what the Hub does with the Lambda runtime's
# copy (src/providers/rdsCa.ts).
#
# Fetched when the image is built, from the address the RDS and DocumentDB guides give, so a region
# AWS adds later is in the next image with no change here. Owned by `node` because a file ADD
# fetches is mode 600, and Node skips an unreadable bundle with only a warning.
ADD --chown=node:node https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/app/rds-global-bundle.pem

COPY --chown=node:node index.mjs ./index.mjs

# The default the runtime listens on. It must match `containerPort` in the task definition and the
# port on the target group -- a mismatch fails the health check, and ECS then replaces the task
# every few minutes with nothing in the log to say why.
EXPOSE 8080

# Straight to node, no shell wrapper: PID 1 has to be the process that handles SIGTERM, or ECS
# waits out StopTimeout and kills the container mid-request on every deployment.
CMD ["node", "index.mjs"]
