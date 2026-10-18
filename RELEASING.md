# Releasing

## 1. Run deterministic gates

Use Node.js 22.6 or newer from a clean checkout. No dependency installation, network access, Cursor login, or quota is required.

```sh
npm test
npm run test:e2e
node tools/secret-scan.mjs
git status --short
```

All checks must pass, and the final command must show no unintended files.

## 2. Run the opt-in real CLI smoke

This uses the local Cursor login and consumes quota for two model turns:

```sh
CURSOR_PI_E2E_REAL=1 npm run test:e2e:real
```

Its second turn uses the default `--force` to write one probe file in a temporary directory, so run it from an appropriate workspace. Do not set `CURSOR_PI_NO_FORCE=1`: the smoke requires `--force`, and without it `cursor-agent` also refuses a workspace it has not been told to trust.

## 3. Verify the package in Pi

Use a disposable workspace and a Pi configuration where no other copy of the provider can shadow the checkout.

1. Install the checkout with `pi install .`.
2. Run `pi --list-models` from a cold Pi start and confirm that it lists non-empty `cursor/<family>` entries. This verifies local discovery during the initial `allowNetwork: false` refresh.
3. Start Pi, select a listed Cursor model, and complete a text turn.
4. With the default configuration, request a harmless shell edit inside the disposable workspace and confirm that the tool call completes when Cursor's deny rules allow it.
5. Start Pi with `CURSOR_PI_NO_FORCE=1`, request an approval-gated shell action, and confirm that it is rejected rather than waiting for a prompt. First trust the disposable workspace by running `cursor-agent` there interactively once; otherwise the rejection comes from the workspace-trust check and the approval gate is never exercised.
6. Confirm that each reply appears once, including text before and after a tool call.

Do not continue if discovery, streaming, default tool execution, or the opt-out behavior differs.

## 4. Publish

1. Confirm the version, release commit, MIT `LICENSE`, `THIRD_PARTY.md`, README, and clean secret scan.
2. Create `github.com/the-shop/pi-cursor-provider`, configure it as the Git remote, and push the reviewed branch and release tag.
3. Make the repository public and verify a fresh GitHub install with `pi install git:github.com/the-shop/pi-cursor-provider`.
4. Pin the release commit as a submodule in `github.com/the-shop/ts-open-source`.
5. Update that repository's README table and CI configuration to include `pi-cursor-provider`.
6. Run the public repository and `ts-open-source` CI checks, then publish the GitHub release.

This package is installed from GitHub; do not publish it to npm unless the distribution policy changes explicitly.
