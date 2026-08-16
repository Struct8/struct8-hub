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
  a test for it. 148 tests, no network.
- AWS Lambda runtime.
- README and getting-started guide in English and Brazilian Portuguese.

### Fixed

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
