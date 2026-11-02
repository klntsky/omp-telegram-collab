# Development

For behavior and permissions, see [Product](PRODUCT.md). For component ownership and trust boundaries, see [Architecture](ARCHITECTURE.md).

For consumer installation, setup, configuration, deployment, and normal service operations, see the [README](README.md#setup).

## Contributor setup

Install nvm, pnpm, and OMP. Use the Node.js LTS version pinned in `.nvmrc`; older runtimes are unsupported. From a checkout, select the runtime, install dependencies, and build:

```sh
nvm install
nvm use
pnpm install --frozen-lockfile
pnpm build
```

Use a separate configuration, data directory, bot, and forum for local development. Follow the [consumer setup](README.md#setup), then run the source entry point:

```sh
pnpm dev --config /path/to/development/config.yaml
```

Configure model credentials for the development account through OMP. Do not reuse production tokens or run a second service against production state.

## Change the database schema

Append SQL to the migration list in `src/migrations.ts`. Each list entry advances the database version by one. Keep applied entries unchanged and in order. Do not include transaction statements in migration SQL.

Store startup applies pending entries in one transaction, including their version updates. A failure rolls back the entire pending upgrade and preserves the original SQLite error. There are no down migrations.

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

Local fixtures use OS-assigned ephemeral ports and keep each listener bound until teardown. Use the returned `app.url` for loopback transport and `app.config.publicUrl` for the gateway Origin header; the configured public origin is independent of the listening port. Bot or gateway initialization failures close the resources already started and preserve the original startup diagnostic.

Run one file or select a test by name (a regular expression), with flags before paths:

```sh
timeout 60s pnpm test:one test/auth.test.ts
timeout 60s pnpm test:one --test-name-pattern '^WebSocket tickets are single-use and expire at their boundary$' test/auth.test.ts
```

`test:one` accepts Node test-runner flags and one or more paths without adding the full-suite glob. Run the disposable real-process kill check with `timeout 180s pnpm exec tsx scripts/runtime-kill-smoke.ts`.

Live Telegram verification requires a BotFather token and forum groups. Mini App verification also requires its BotFather registration and HTTPS deployment. Local fixtures cannot verify BotFather settings or Telegram client behavior. Keep services that own active coding sessions running while testing lifecycle notices elsewhere.

## Run tests against Telegram's test network

Register a real phone number in Telegram's [separate test environment](https://core.telegram.org/bots/features#testing-your-bot) and keep an official client logged into that account. Reserved fixed-code test accounts are [disabled](https://github.com/tdlib/td/issues/3083#issuecomment-3710841964).

Obtain an application `api_id` and `api_hash` from [Telegram's application settings](https://my.telegram.org/apps). Put them in this checkout's untracked `.env`:

```dotenv
TELEGRAM_TEST_API_ID=YOUR_APPLICATION_ID
TELEGRAM_TEST_API_HASH=YOUR_APPLICATION_HASH
```

Run the source-controlled login command in an interactive terminal:

```sh
pnpm telegram:test:login
```

Enter the registered test-network phone number with its country code, the actual verification code delivered to the account, and its two-step verification password if requested. Code and password input are hidden. The command verifies the test network and appends `TELEGRAM_TEST_SESSION` to `.env` without printing it. It preserves existing configuration and sets `.env` permissions to `0600`. Rerunning the command appends a refreshed session; the latest entry is used.

Login supports Telegram moving the connection to the account's home datacenter. No datacenter configuration is required.

The saved session grants access to the test account. Never log it, commit it, send it in chat, or publish it as an artifact. Revoke the authorization in the account's device settings if it leaks.

Run live tests after login:

```sh
timeout 480s pnpm test:e2e
```

Both commands load `.env` automatically. Exported shell variables take precedence over file values. `test:e2e` is separate from `test` and `verify`; missing credentials fail instead of skipping tests. The helper imports the saved session into in-memory storage and rejects production-network or bot sessions. It does not request a fresh login code on every run. Install OMP before running the suite; set `OMP_EXECUTABLE` to select a different executable.

Set `TELEGRAM_TEST_BOT_TOKEN` to reuse a bot already created in the test environment. Otherwise, the fixture creates a uniquely named bot through that environment's BotFather. Created bots remain in the test account for reuse; the helpers do not issue BotFather's irreversible bot-deletion command. Retrieve a reusable token through BotFather in the test environment. Never log tokens or commit them.

Each fixture creates its own forum and deletes that forum during teardown, including after partial setup failure. Teardown closes the owned user client without logging the account out or revoking its saved session. Do not run concurrent fixtures with the same account while they are creating bots, or run another `getUpdates` consumer against the fixture's bot token. Give parallel workers separate accounts and bots.

Import `setupTelegramTest` from `test/e2e/helpers/telegram-fixture.ts` in live tests. It registers teardown with the Node test context and returns the authenticated user, bot, test Bot API client, forum, and update inbox. Lower-level login and provisioning helpers are available in the same directory when a test needs different ownership. Keep domain scenarios and assertions in test files, not in the setup helpers.

Telegram's test environment still enforces flood limits. The helpers wait for explicit flood rejections, respect cancellation, and retain original failure diagnostics. A timeout is a failure, not evidence that setup completed. If provisioning fails, inspect the original BotFather or RPC response before rerunning; an ambiguous network failure may have created a remote resource.

### Isolated OMP and debug artifacts

The OMP helper launches each child with an allowlisted environment and disposable home, agent, XDG, workspace, and application directories. It does not forward provider credentials or personal OMP configuration. Model requests use a scripted loopback HTTP provider with a fake key. No container or paid model credentials are needed. This configuration isolation is not a filesystem sandbox.

The full-path fixture uses the actual test-network user session and application poller. Keep tests sharing an account and bot in `test/e2e/telegram.test.ts`, where top-level tests run sequentially. Separate files still run with concurrency five; use distinct credentials before adding parallel live fixtures.

`BotOptions.topicActivityEmojis` configures the running and finished topic emojis in code. Normal startup keeps ⚡ and 🏁. The live fixture selects two distinct emojis from the test server's `getForumTopicIconStickers` response and records the selection in the trace. It does not substitute Telegram API responses.

Each application run prints a private debug-artifact directory. `events.jsonl` contains ordered, timestamped test stages, provider requests and SSE frames, Telegram API requests/results and real updates, userbot-received messages, Collab frames, and application console diagnostics. Terminal output and conversation histories are copied under `sessions/` during cleanup. Disposable configuration and workspace files are removed; debug artifacts remain outside the checkout.

Inspect a retained run without rerunning it:

```sh
pnpm e2e:inspect /tmp/EXAMPLE_E2E_LOG_DIRECTORY
pnpm e2e:inspect /tmp/EXAMPLE_E2E_LOG_DIRECTORY --event step
pnpm e2e:inspect /tmp/EXAMPLE_E2E_LOG_DIRECTORY --event fake-llm --full
pnpm e2e:inspect /tmp/EXAMPLE_E2E_LOG_DIRECTORY --event telegram --full
```

The inspector lists terminal/history paths and preserves complete error diagnostics. `--event` selects an event-name substring; `--full` prints complete payloads. Known test tokens, API hashes, and saved sessions are redacted from the JSONL trace and captured console output. Artifacts still contain prompts, model responses, and tool output; keep the directory private and do not publish it without inspection.

To run only the OMP scenario, place test-runner flags before the file path:

```sh
timeout 300s pnpm exec node --env-file-if-exists=.env --import tsx --test --test-concurrency=5 --test-name-pattern '^userbot task' test/e2e/telegram.test.ts
```

## Debugging

Use `pm2 logs omp-telegram-collab` for deployed service diagnostics. If configuration was saved but not applied, correct the reported error and run `pnpm cli reload`. The Mini App exchanges fresh Telegram launch data once for a long-lived backend credential, cached in memory and session storage per launch and scoped to the bot/session. It reuses that credential for reloads and automatic reconnects, including after service restarts; elapsed launch age alone does not require reopening Telegram. Credentials are signed using the bot token, bind the bot/session/user and session generation, and have no time expiry. The backend refreshes membership on reconnect, before writes, and periodically for active sockets, revoking access when membership is lost; reads reuse established authorization. Backend and network failures preserve their original diagnostics. If capacity is exhausted, close unused Mini Apps or increase the configured limit before selecting Rejoin.

Use `/status` in General or the affected topic before inspecting process logs; see [Product](PRODUCT.md) for its diagnostic scope and interpretation. Status observations reset with the bot process, so use the service logs when investigating failures from a previous process.

Failure diagnostics preserve the original operation error, including multiline OMP discovery messages. Telegram operation failures are logged, and subprocess failure reports retain available exit codes, signals, and killed status. Inspect those original diagnostics rather than treating a generic startup or Telegram failure summary as the cause.

During new managed-host startup, an `omp collab link` failure with `no active Collab host matches` returns to host discovery until the existing `startupTimeoutMs` deadline. The runtime preserves the last original subprocess error if the deadline expires. If the final discovery probe is killed at that deadline, its error is retained as the original rejection's `cause`, rather than replacing the rejection's exit code and diagnostics. This recovery does not apply to attached hosts, existing managed hosts, or identity-validation failures.

Telegram transport uses [grammY](https://grammy.dev/). API rejections expose `GrammyError.error_code`, `description`, and `parameters`; network failures expose the original failure through `HttpError.error`. Preserve the native error object in server-side diagnostics. Telegram replies retain grammY's safe `HttpError.message`, not the private transport message, which can contain a token-bearing URL. The Node client requires `abort-controller` signals at its API boundary; application background work uses native cancellation.

Managed hosts capture raw PTY output in `dataDir/sessions/SESSION_ID/terminal.log`, rotating to `terminal.log.1` at 1 MiB per file (at most 2 MiB per session). Files are mode 0600 and remain until the session data is removed; restarts append a launch marker. Output includes terminal escape sequences and redraws and may contain prompts, responses, tool output, paths, or secrets. Treat both files as sensitive; do not publish them or render untrusted terminal output directly. Startup failures identify the private log path without forwarding raw output to Telegram or PM2. Already-running supervisors begin logging only when their managed host is next launched.
