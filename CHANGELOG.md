# Changelog

Notable changes to `@struct8/hub`. The **wiring contract** carries its own version, independent of
this package's — a package release does not imply a contract change, and a contract change is
always called out here explicitly.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing is published yet. The repository currently holds documentation and the type spine.

### Added

- Wiring contract v1, documenting the environment-variable grammar as the generator emits it
  today, including the two gaps it does not yet cover: no incoming side, and the retired
  `TARGET_` format.
- Architecture: four ports, one rule (the core imports no cloud SDK), and the seams held open for
  cross-provider work.
- Type spine (`src/core/types.ts`).
- README and getting-started guide in English and Brazilian Portuguese.

### Next

- Core: `discovery`, `envelope`, `registry`, `report`, `hub`.
- AWS Lambda runtime.
