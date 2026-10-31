# Development

For behavior and permissions, see [Product](PRODUCT.md). For component ownership and trust boundaries, see [Architecture](ARCHITECTURE.md).

For consumer installation, setup, configuration, deployment, and normal service operations, see the [README](README.md#setup).

## Contributor setup

Install Node.js 22.13 or newer, pnpm, and OMP. From a checkout, install dependencies and build:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Use a separate configuration, data directory, bot, and forum for local development. Follow the [consumer setup](README.md#setup), then run the source entry point:

```sh
pnpm dev --config /path/to/development/config.yaml
```

Configure model credentials for the development account through OMP. Do not reuse production tokens or run a second service against production state.



## Modify the Mini App

The editable Collab Web client lives in `web/src`. `web/upstream.json` records its upstream revision, and `web/LICENSE.upstream` preserves the license. Authentication and WebSocket transport are local adaptations. Run `pnpm build` after changes.

## Verify changes

```sh
pnpm verify
```

`verify` requires typechecking, the isolated suite, a production build, and all integration stages to pass, in that order. Run it on the pull request revision in a disposable checkout, not on master. Use an explicit outer timeout, for example `timeout 600s pnpm verify`; timeout is failure, not a skip or pass.

`check` typechecks the backend, Mini App, tests, and TypeScript scripts. `test` runs isolated test files with concurrency five; mocked collaborators only establish local behavior, not compatibility with the external service they imitate. `test:integration` builds production artifacts and runs `smoke`.

Telegram slash-command syntax lives in `src/telegram-commands.grammar`. After changing the grammar, run `pnpm generate:commands` and commit both generated files, `src/telegram-command-parser.ts` and `src/telegram-command-parser.terms.ts`. Both `pnpm check` and `pnpm build` regenerate them. The tokenizer supplies named terminals at their original message offsets; the parser reads the original message, not an encoded command alphabet. Lezer's generator is a development dependency; production uses the generated tables and `@lezer/lr` with strict parsing. Unresolved grammar conflicts fail generation. Do not add ambiguity annotations or parser recovery to accept conflicting command forms.

`smoke` runs CLI, Telegram, gateway, and OMP runtime stages in separate subprocesses. Run a stage with `pnpm smoke:cli`, `pnpm smoke:telegram`, `pnpm smoke:gateway`, or `pnpm smoke:runtime`. Select several with `pnpm smoke telegram gateway`. The CLI stage requires a current build. The runtime stage requires an installed OMP and enough resources to start within its timeout. Its model-executing lifecycle checks also require configured model credentials. Local fixtures need no live Telegram credentials.

The Telegram stage uses a local fake Telegram HTTP service; the gateway stage uses real loopback HTTP/WebSocket transport but substitutes the host connector. Neither establishes live Telegram or actual OMP compatibility. The runtime stage uses an actual OMP subprocess and encrypted Collab traffic through a local forwarding relay; it does not establish compatibility with the production relay. Passing local integration checks is not evidence that BotFather settings, deployed networking, or Telegram clients work.

Run one file or select a test by name (a regular expression), with flags before paths:

```sh
timeout 60s pnpm test:one test/auth.test.ts
timeout 60s pnpm test:one --test-name-pattern '^WebSocket tickets are single-use and expire at their boundary$' test/auth.test.ts
```

`test:one` accepts Node test-runner flags and one or more paths without adding the full-suite glob. Run the disposable real-process kill check with `timeout 180s pnpm exec tsx scripts/runtime-kill-smoke.ts`.

Live Telegram verification requires a BotFather token and forum groups. Mini App verification also requires its BotFather registration and HTTPS deployment. Local fixtures cannot verify BotFather settings or Telegram client behavior. Keep services that own active coding sessions running while testing lifecycle notices elsewhere.

## Run tests against Telegram's test network

Obtain an application `api_id` and `api_hash` from [Telegram's application settings](https://my.telegram.org/apps). Set them only for the test process:

```sh
export TELEGRAM_TEST_API_ID='YOUR_APPLICATION_ID'
export TELEGRAM_TEST_API_HASH='YOUR_APPLICATION_HASH'
timeout 240s pnpm test:e2e
```

`test:e2e` is separate from `test` and `verify`. Missing credentials fail the command instead of skipping live tests. These tests use Telegram's [separate test environment](https://core.telegram.org/bots/features#testing-your-bot), never the production Bot API. They do not launch OMP or invoke inference.

The helpers use in-memory MTProto sessions and generate a reserved test phone number by default. Set `TELEGRAM_TEST_PHONE` to a number in the `99966XYYYY` format to select an account. `X` is the test datacenter number from 1 to 3. Do not use personal phone numbers. Test accounts have publicly predictable login codes and Telegram periodically wipes their data. Never put private data in them.

Set `TELEGRAM_TEST_BOT_TOKEN` to reuse a bot already created in the test environment. Otherwise, the fixture creates a uniquely named bot through that environment's BotFather. Created bots remain in the test account for reuse; the helpers do not issue BotFather's irreversible bot-deletion command. Retrieve a reusable token through BotFather in the test environment. Never log tokens or commit them.

Each fixture creates its own forum and deletes that forum during teardown, including after partial setup failure. Teardown closes the owned user session. Do not run concurrent fixtures with the same fixed phone account while they are creating bots, or run another `getUpdates` consumer against the fixture's bot token. Give parallel workers separate accounts and bots.

Import `setupTelegramTest` from `test/e2e/helpers/telegram-fixture.ts` in live tests. It registers teardown with the Node test context and returns the authenticated user, bot, test Bot API client, forum, and update inbox. Lower-level login and provisioning helpers are available in the same directory when a test needs different ownership. Keep domain scenarios and assertions in test files, not in the setup helpers.

Telegram's test environment still enforces flood limits. The helpers wait for explicit flood rejections, respect cancellation, and retain original failure diagnostics. A timeout is a failure, not evidence that setup completed. If provisioning fails, inspect the original BotFather or RPC response before rerunning; an ambiguous network failure may have created a remote resource.

## Debugging

Use `pm2 logs omp-telegram-collab` for deployed service diagnostics. If configuration was saved but not applied, correct the reported error and run `pnpm cli reload`. The Mini App exchanges fresh Telegram launch data once for a long-lived backend credential, cached in memory and session storage per launch and scoped to the bot/session. It reuses that credential for reloads and automatic reconnects, including after service restarts; elapsed launch age alone does not require reopening Telegram. Credentials are signed using the bot token, bind the bot/session/user and session generation, and have no time expiry. The backend refreshes membership on reconnect, before writes, and periodically for active sockets, revoking access when membership is lost; reads reuse established authorization. Backend and network failures preserve their original diagnostics. If capacity is exhausted, close unused Mini Apps or increase the configured limit before selecting Rejoin.

Use `/status` in General or the affected topic before inspecting process logs; see [Product](PRODUCT.md) for its diagnostic scope and interpretation. Status observations reset with the bot process, so use the service logs when investigating failures from a previous process.

Failure diagnostics preserve the original operation error, including multiline OMP discovery messages. Telegram operation failures are logged, and subprocess failure reports retain available exit codes, signals, and killed status. Inspect those original diagnostics rather than treating a generic startup or Telegram failure summary as the cause.

During new managed-host startup, an `omp collab link` failure with `no active Collab host matches` returns to host discovery until the existing `startupTimeoutMs` deadline. The runtime preserves the last original subprocess error if the deadline expires. If the final discovery probe is killed at that deadline, its error is retained as the original rejection's `cause`, rather than replacing the rejection's exit code and diagnostics. This recovery does not apply to attached hosts, existing managed hosts, or identity-validation failures.

Telegram transport uses [grammY](https://grammy.dev/). API rejections expose `GrammyError.error_code`, `description`, and `parameters`; network failures expose the original failure through `HttpError.error`. Preserve the native error object in server-side diagnostics. Telegram replies retain grammY's safe `HttpError.message`, not the private transport message, which can contain a token-bearing URL. The Node client requires `abort-controller` signals at its API boundary; application background work uses native cancellation.

Managed hosts capture raw PTY output in `dataDir/sessions/SESSION_ID/terminal.log`, rotating to `terminal.log.1` at 1 MiB per file (at most 2 MiB per session). Files are mode 0600 and remain until the session data is removed; restarts append a launch marker. Output includes terminal escape sequences and redraws and may contain prompts, responses, tool output, paths, or secrets. Treat both files as sensitive; do not publish them or render untrusted terminal output directly. Startup failures identify the private log path without forwarding raw output to Telegram or PM2. Already-running supervisors begin logging only when their managed host is next launched.
