# Public source review

Reviewed on 2026-09-28 before changing `clocksmith/m3t4` to public. The owner
selected MIT for the original repository contents, including the checked-in
strategy presets and tuning artifacts. This supersedes the former undecided
license and proprietary-preset note in the README.

## Scope and results

- Reviewed the fetched `main` branch and tags. Git reported 255 reachable
  commits; Gitleaks scanned 250 commits containing changes with
  `--log-opts='--all --full-history' --redact --ignore-gitleaks-allow`.
- Triaged all five scanner findings: four occurrences of browser storage-key
  names and one Firebase client API key. No private credential was identified.
- Checked the Firebase key's live metadata: it is the Firebase-created browser
  key with an API service allowlist. Firebase client config identifies the
  deployed app; it does not contain an Admin SDK credential. See
  [Firebase's API-key guidance](https://firebase.google.com/docs/projects/api-keys).
- Checked all three historical versions of `functions/.env.m3ta-ai`. Their
  TURN username/password are the provider's published Open Relay demo values,
  documented by [Metered](https://www.metered.ca/tools/openrelay/).
- Checked 36 unique historical `server/data/m3t4.json` snapshots and the
  `server/data/configs.json` snapshot: all 636 stable/config owner records were
  system presets. No non-system owner was found in those records.
- Reviewed the provisioning runbook and asset-generation documentation. The
  runbook contains deployment identifiers and commands, rather than private
  service-account keys or administrative tokens. Promoted artwork has an
  in-repository generation workflow.
- Reviewed dependency license metadata and documented the optional proof
  tooling's GPL dependencies in [third-party notices](../THIRD_PARTY_NOTICES.md).

The review covers checked-in source and reachable history. It is not a
penetration test, a review of live player data, or a guarantee that automated
secret detection finds every possible sensitive value. Publishing the source
does not enable public compute intake or change production settings.
