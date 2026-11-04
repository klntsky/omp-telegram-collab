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

Keep one current schema in `src/migrations.ts`; collapse schema changes into that definition rather than appending compatibility migrations. Update fixtures and callers together. Older schemas are unsupported and must not be imported automatically.

Store startup initializes a new database atomically and rejects unsupported schemas. Schema initialization failures preserve the original SQLite diagnostic.

## Modify the Mini App

The editable Collab Web client lives in `web/src`. `web/upstream.json` records its upstream revision, and `web/LICENSE.upstream` preserves the license. Authentication and WebSocket transport are local adaptations. Run `pnpm build` after changes.

## Verify changes

```sh
pnpm verify
```

`verify` requires live Telegram end-to-end tests, typechecking, the isolated suite, a production build, and all integration stages to pass, in that order. Configure the saved test-network authorization described below before running it. Run it on the pull request revision in a disposable checkout, not on master. Use an explicit outer timeout, for example `timeout 900s pnpm verify`; timeout is failure, not a skip or pass.

`check` typechecks the backend, Mini App, tests, and TypeScript scripts. `test` runs isolated test files with concurrency five; mocked collaborators only establish local behavior, not compatibility with the external service they imitate. `test:integration` builds production artifacts and runs `smoke`.

Choose tests from the behavior in [Product](PRODUCT.md), not the inventory of internal methods. Prefer live end-to-end coverage for successful workflows across Telegram, BotService, and OMP. Keep deterministic isolated coverage for authorization, data preservation, cancellation, retry timing, and races with observable product consequences. Prefer existing bot-level scenarios over a second matrix for their internal helpers. Dependency internals, fixture self-tests, trivial accessor roundtrips, and display wording do not need permanent tests. When replacing meaningful isolated coverage with a live case, compare the actual input handling, protocol data, persisted state, and side effects; shared command names alone do not establish duplication.

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

Live tests use one shared local test-session server. It owns the Telegram user authorization and allocates an exclusive bot token to each run. Checkouts connect to its private Unix socket; they do not import the saved Telegram session. Application Bot API requests still go directly to Telegram.

### Set up the shared server

Register a real phone number in Telegram's [separate test environment](https://core.telegram.org/bots/features#testing-your-bot) and keep an official client logged into that account. Reserved fixed-code test accounts are [disabled](https://github.com/tdlib/td/issues/3083#issuecomment-3710841964).

Use a stable checkout for the PM2 process. Install its dependencies with the current Node.js LTS selected through nvm. Obtain an application `api_id` and `api_hash` from [Telegram's application settings](https://my.telegram.org/apps), and put them in that checkout's untracked `.env`:

```dotenv
TELEGRAM_TEST_API_ID=YOUR_APPLICATION_ID
TELEGRAM_TEST_API_HASH=YOUR_APPLICATION_HASH
```

Run the login command in an interactive terminal from that checkout:

```sh
pnpm telegram:test:login
```

Enter the test-network phone number, verification code, and two-step verification password if requested. Code and password input are hidden. Login verifies the test network and appends `TELEGRAM_TEST_SESSION` to `.env` with permissions `0600`, without printing it. Do not copy that authorization into other checkouts or run another client with it. `AUTH_KEY_DUPLICATED` invalidates the authorization and requires another login.

Exported environment variables take precedence over `.env`. After refreshing the saved session, unset any stale exported `TELEGRAM_TEST_SESSION` before starting or restarting the server. Stop the server before refreshing its authorization.

The PM2 configuration loads credentials from the central checkout's `.env` and excludes inherited Telegram credential variables. Its `.env` file must exist before startup.

The server uses `~/.local/state/omp-telegram-test` by default for its protected persistent state, with the socket at `session.sock` inside that directory. Set `TELEGRAM_TEST_DATA_DIR` to choose another server state directory. Set `TELEGRAM_TEST_SOCKET` on both server and clients to choose another socket path. These paths must be shared across checkouts, not created inside each worktree.

Optionally set `TELEGRAM_TEST_BOT_TOKEN` in the server environment to seed the pool with a pre-created test-network bot. The server reuses available bots and creates another through BotFather when all known bots are unavailable. Bot creation is serialized across runs. Tokens remain in the protected pool for reuse; the server does not delete bots. Do not use pooled bots in another service or poll them outside their assigned test run.

Run the server in the foreground when diagnosing setup:

```sh
pnpm telegram:test:server
```

For shared use, install PM2 and start the supplied single-instance fork configuration:

```sh
pnpm add --global pm2
pm2 start ecosystem.telegram-test.cjs
pm2 save
pm2 logs omp-telegram-test-server
```

Start PM2 with the intended Node.js LTS selected. Do not use cluster mode or increase the process count. The process announces readiness only after authenticating the user and opening the protected socket. A second server cannot take over the same state while the first owns it.

The server does not throttle, sleep on flood errors, retry Telegram requests, or replay failed mutations. Telegram errors retain their original messages and fields. The application's production Bot API handling remains responsible for its own rate-limit behavior.

### Run from any checkout

Install OMP and this checkout's dependencies, then run:

```sh
timeout 600s pnpm test:e2e
```

Set `OMP_EXECUTABLE` to choose another OMP executable. Set `TELEGRAM_TEST_SOCKET` if the server uses a non-default socket. Test clients do not need `TELEGRAM_TEST_API_ID`, `TELEGRAM_TEST_API_HASH`, `TELEGRAM_TEST_SESSION`, or a manually selected bot token.

Each fixture acquires a bot token, creates its own forum, and keeps its working directories, database, and OMP processes separate. Teardown stops application polling and removes the forum before returning the token to the pool. There is no separate lease ID. Unexpected disconnects and server restarts quarantine affected tokens rather than assigning a potentially live bot to another test.

Before recovering a quarantined token, stop every old poller using it and stop the shared server. Supply the token through `TELEGRAM_TEST_RECOVER_TOKEN`, not a shell argument, then run:

```sh
pnpm telegram:test:server recover
pm2 restart omp-telegram-test-server
```

Unset `TELEGRAM_TEST_RECOVER_TOKEN` afterward. Never log or commit the session, bot tokens, pool database, or recovery environment. A token must not be recovered merely because its client disconnected.

`test:e2e` is separate from the isolated `test` suite and runs first in `verify`. Missing server access, invalid credentials, provisioning failures, and timeouts fail acceptance rather than skipping tests. Inspect original BotFather or RPC diagnostics before rerunning; an ambiguous failure may already have created a remote resource.

Use `setupCollaborationTest` from `test/e2e/helpers/collaboration-fixture.ts` for application workflows and `setupTelegramTest` for lower-level Telegram resources. Both register teardown with the Node test context. Keep scenario-specific transitions and expectations in test files rather than setup helpers.

Forum provisioning retries only the explicit test-network RPC rejection `500 CHAT_OCCUPY_LOC_FAILED`, checking for an already-created matching forum before retrying. This fixture policy runs outside the server; the server itself does not recover or transform Telegram failures.

### Isolated OMP and debug artifacts

The OMP helper launches each child with an allowlisted environment and disposable home, agent, XDG, workspace, and application directories. The workspace starts as a real Git repository with a fixture-only author identity. It does not forward provider credentials or personal OMP configuration. Model requests use a scripted loopback HTTP provider with a fake key. No container or paid model credentials are needed. This configuration isolation is not a filesystem sandbox.

The disposable agent directory contains suite-owned skill files, and the scripted model declares image input support. Skill discovery uses that isolated OMP configuration. Uploaded image documents pass through Telegram's real file service before reaching the provider. File downloads use the bot client's selected production or test environment.

Define scripted provider responses per named task, with the expected user prompt and its tool/text steps. The provider matches only the latest user message, keeps request history and progress per task, and verifies tool-result IDs before continuing. Task ordering across sessions does not determine which response is sent. Unexpected prompts, extra requests, and unfinished tasks fail with task-specific diagnostics. Telegram transport, BotService, OMP, and tool execution remain real.

Managed interactive hosts enable OMP's `write` and `ask` tools. Headless RPC helpers enable `write` only because `ask` requires an interactive host. A declared `await-abort` provider step holds the SSE connection open until OMP cancels it; completion requires the connection to close without completing the stream. An `ECONNRESET` on that specific connection is retained in the trace as an expected cancellation diagnostic. Other transport errors still fail the workflow.

The live suite reuses one authenticated user, forum, application, and OMP environment across ordered workflows. `sendAndWait` waits for the bot to finish handling the actual Telegram update. `restart` closes the previous service and runtime, reopens the database, and constructs replacement runtime and bot-service instances without provisioning another forum. Separate files still run with concurrency five; distinct credentials are required for parallel live fixtures.

`BotOptions.topicActivityEmojis` configures the running and finished topic emojis in code. Normal startup keeps ⚡ and 🏁. The live fixture selects two distinct emojis from the test server's `getForumTopicIconStickers` response and records the selection in the trace. It does not substitute Telegram API responses.

When the test server rejects a message-reaction emoji with `REACTION_INVALID`, the original API diagnostic remains in the trace. A reaction request alone is not evidence of visible delivery; inspect its recorded API result.

Each application run prints a private debug-artifact directory. `events.jsonl` contains ordered, timestamped test stages, provider requests and SSE frames, Telegram API requests/results and real updates, userbot-received messages, Collab frames, and application console diagnostics. Terminal output and conversation histories are copied under `sessions/` during cleanup. Disposable configuration and workspace files are removed; debug artifacts remain outside the checkout.

Inspect a retained run without rerunning it:

```sh
pnpm e2e:inspect /tmp/EXAMPLE_E2E_LOG_DIRECTORY
pnpm e2e:inspect /tmp/EXAMPLE_E2E_LOG_DIRECTORY --event step
pnpm e2e:inspect /tmp/EXAMPLE_E2E_LOG_DIRECTORY --event fake-llm --full
pnpm e2e:inspect /tmp/EXAMPLE_E2E_LOG_DIRECTORY --event telegram --full
```

The inspector lists terminal/history paths and preserves complete error diagnostics. `--event` selects an event-name substring; `--full` prints complete payloads. Known test tokens, API hashes, and saved sessions are redacted from the JSONL trace and captured console output. Artifacts still contain prompts, model responses, and tool output; keep the directory private and do not publish it without inspection.

To select the shared live workflow, place test-runner flags before the file path:

```sh
timeout 600s pnpm exec node --env-file-if-exists=.env --import tsx --test --test-concurrency=5 --test-name-pattern '^Telegram workflows' test/e2e/telegram.test.ts
```

## Debugging

Use `pm2 logs omp-telegram-collab` for deployed service diagnostics. If configuration was saved but not applied, correct the reported error and run `pnpm cli reload`. The Mini App exchanges fresh Telegram launch data once for a long-lived backend credential, cached in memory and session storage per launch and scoped to the bot/session. It reuses that credential for reloads and automatic reconnects, including after service restarts; elapsed launch age alone does not require reopening Telegram. Credentials are signed using the bot token, bind the bot/session/user and session generation, and have no time expiry. The backend refreshes membership on reconnect, before writes, and periodically for active sockets, revoking access when membership is lost; reads reuse established authorization. Backend and network failures preserve their original diagnostics. If capacity is exhausted, close unused Mini Apps or increase the configured limit before selecting Rejoin.

Use `/status` in General or the affected topic before inspecting process logs; see [Product](PRODUCT.md) for its diagnostic scope and interpretation. Status observations reset with the bot process, so use the service logs when investigating failures from a previous process.

Failure diagnostics preserve the original operation error, including multiline OMP discovery messages. Telegram operation failures are logged, and subprocess failure reports retain available exit codes, signals, and killed status. Inspect those original diagnostics rather than treating a generic startup or Telegram failure summary as the cause.

During new managed-host startup, an `omp collab link` failure with `no active Collab host matches` returns to host discovery until the existing `startupTimeoutMs` deadline. The runtime preserves the last original subprocess error if the deadline expires. If the final discovery probe is killed at that deadline, its error is retained as the original rejection's `cause`, rather than replacing the rejection's exit code and diagnostics. This recovery does not apply to attached hosts, existing managed hosts, or identity-validation failures.

Telegram transport uses [grammY](https://grammy.dev/). API rejections expose `GrammyError.error_code`, `description`, and `parameters`; network failures expose the original failure through `HttpError.error`. Preserve the native error object in server-side diagnostics. Telegram replies retain grammY's safe `HttpError.message`, not the private transport message, which can contain a token-bearing URL. The Node client requires `abort-controller` signals at its API boundary; application background work uses native cancellation.

Managed hosts capture raw PTY output in `dataDir/sessions/SESSION_ID/terminal.log`, rotating to `terminal.log.1` at 1 MiB per file (at most 2 MiB per session). Files are mode 0600 and remain until the session data is removed; restarts append a launch marker. Output includes terminal escape sequences and redraws and may contain prompts, responses, tool output, paths, or secrets. Treat both files as sensitive; do not publish them or render untrusted terminal output directly. Startup failures identify the private log path without forwarding raw output to Telegram or PM2. Already-running supervisors begin logging only when their managed host is next launched.
