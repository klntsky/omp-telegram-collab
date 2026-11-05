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

`verify` runs live Telegram end-to-end tests, typechecking, the isolated suite, a production build, and the CLI and OMP runtime checks, in that order. Configure the saved test-network authorization described below before running it. Use an explicit outer timeout, for example `timeout 2400s pnpm verify`.

`check` typechecks the backend, Mini App, tests, and TypeScript scripts. `test` runs isolated test files with concurrency five. `test:integration` builds production artifacts and runs `smoke`.

Telegram slash-command syntax lives in `src/telegram-commands.grammar`. After changing the grammar, run `pnpm generate:commands` and commit both generated files, `src/telegram-command-parser.ts` and `src/telegram-command-parser.terms.ts`. Both `pnpm check` and `pnpm build` regenerate them. The tokenizer supplies named terminals at their original message offsets; the parser reads the original message, not an encoded command alphabet. Lezer's generator is a development dependency; production uses the generated tables and `@lezer/lr` with strict parsing. Unresolved grammar conflicts fail generation. Do not add ambiguity annotations or parser recovery to accept conflicting command forms.

`smoke` runs CLI and OMP runtime checks in separate subprocesses. Run a stage with `pnpm smoke:cli` or `pnpm smoke:runtime`, or select both with `pnpm smoke cli runtime`. The CLI stage requires a current build. The runtime stage requires an installed OMP and configured model credentials for its model-executing checks.

The runtime stage uses an actual OMP subprocess and encrypted Collab traffic through a local forwarding relay. It does not verify the production relay or Telegram connectivity.

Run one file or select a test by name (a regular expression), with flags before paths:

```sh
timeout 60s pnpm test:one test/auth.test.ts
timeout 60s pnpm test:one --test-name-pattern '^WebSocket tickets are single-use and expire at their boundary$' test/auth.test.ts
```

`test:one` accepts Node test-runner flags and one or more paths without adding the full-suite glob. Run the disposable real-process kill check with `timeout 180s pnpm exec tsx scripts/runtime-kill-smoke.ts`.

Backend live tests do not replace a check in the Telegram Mini App client. See [README](README.md) for BotFather registration and HTTPS setup.

## Run tests against Telegram's test network

Live test workers own independent Telegram user sessions and lease reusable bots from a shared token array. Each checkout may hold only one bot at a time; bot-using fixtures within that checkout are serialized, while different checkouts can use different bots concurrently. No shared server, proxy, or PM2 test process is needed. Application Bot API requests go directly to Telegram.

### Set up retained sessions

Register a real phone number in Telegram's [separate test environment](https://core.telegram.org/bots/features#testing-your-bot) and keep an official client logged into that account. Reserved fixed-code test accounts are [disabled](https://github.com/tdlib/td/issues/3083#issuecomment-3710841964).

Install dependencies with the current Node.js LTS selected through nvm. Native `flock` from util-linux must be available. Obtain an application `api_id` and `api_hash` from [Telegram's application settings](https://my.telegram.org/apps), and put them in the primary checkout's untracked `.env`:

```dotenv
TELEGRAM_TEST_API_ID=YOUR_APPLICATION_ID
TELEGRAM_TEST_API_HASH=YOUR_APPLICATION_HASH
```

Linked worktrees share the primary checkout's `.env`, resolved through Git's common directory. Set `TELEGRAM_TEST_ENV_FILE` to an absolute shared dotenv path when using separate clones or another credential location. Every participating checkout must use the same file and operating-system account. Credential selection reads this file directly rather than trusting stale exported session values.

Run commands from a checkout containing the current development scripts, with its dependencies installed. The checkout running the command does not need its own `.env`; it resolves the shared file automatically. Run login in an interactive terminal:

```sh
pnpm telegram:test:login
```

Enter the test-network phone number, verification code, and two-step verification password if requested. Code and password input are hidden. Login verifies the test network and retains the authorization in `TELEGRAM_TEST_SESSIONS`, a JSON array in the shared `.env` with permissions `0600`. Existing sessions are retained without printing them, logging out, or revoking them.

### Set up reusable bots

Import an existing test-network bot token:

`pnpm telegram:test:bots add`

The command accepts a hidden terminal prompt or piped stdin. Never supply a token as a command-line argument or paste it into a chat.

Explicitly create another test-network bot through BotFather:

`pnpm telegram:test:bots create`

Both commands validate the token against the real test Bot API and save it in `TELEGRAM_TEST_BOT_TOKENS`, a JSON array in the shared `.env`. They preserve sessions and other bots, deduplicate repeated imports, and enforce `0600` permissions even when the imported token is already saved. They print only the bot ID and dotenv path, never the token. Updating credentials for an existing bot waits for its active lease to finish.

Provision one bot for each checkout that should run concurrently. With one saved token, checkouts take turns; adding tokens increases available capacity. Normal test runs only lease saved bots and never invoke provisioning, create, delete, or revoke bots.

Explicit creation serializes the entire BotFather conversation across checkouts. Only BotFather's explicit “too many attempts” reply is retried after its stated delay; transport failures and ambiguous mutations are not replayed. SIGINT/SIGTERM cancels waits and closes the connection without revoking the retained session. A private `0600` recovery journal under `~/.local/state/omp-telegram-test/provisioned-bots` records the chosen username before the final creation request and the returned token before verification or saving; it is removed after successful saving. If creation fails, inspect that journal privately before retrying: the remote bot may already exist. Use `add` to recover a journaled token. Do not commit or print recovery journals.

BotFather creation limits are account-wide and still apply with independent user sessions. A long creation cooldown does not prevent tests from reusing bots already saved in the array. Use Ctrl-C to cancel provisioning; do not rerun an ambiguous creation blindly.

Each Node.js test worker process locks an available seed and approves one fresh QR-token authorization when its first fixture needs a user. Sequential fixtures exclusively borrow that worker's client; parallel workers and separate checkouts use independent keys. Fixture teardown ends its own request scope without disconnecting the worker's client. The worker's final teardown closes the connection and releases its authorization lease. Failed authorization setup is not replayed by later fixtures in the same worker.

Fresh clients start on the seed's saved test-network datacenter, avoiding an unnecessary cross-datacenter login; server-directed migration remains supported. Saved authorizations already in use are not reused as seeds. Definitively dead sessions are removed before another seed is tried; transient network failures and rate limits retain the credentials and original diagnostic. If no usable seed remains, run interactive login again.

The private state directory under `~/.local/state/omp-telegram-test` owns cross-process locks. Do not unlink live lock files. Authorization forking does not cache flood failures, retry rejected login requests, or replay ambiguous mutations. More sessions do not bypass account-level Telegram limits.

### Run from any checkout

Install OMP and this checkout's dependencies, then run:

```sh
timeout 1800s pnpm test:e2e
```

Set `OMP_EXECUTABLE` to choose another OMP executable.

A checkout waits cancellably if every configured bot is busy, and proceeds when any bot becomes available. A per-bot lock protects the selected bot across checkouts; a per-checkout lock prevents that checkout from acquiring multiple bots simultaneously. Each fixture creates its own forum and keeps working directories, databases, and OMP processes separate. Teardown stops application polling before returning the bot to the pool. Failed or unsettled polling retains the lock rather than granting the bot to another fixture. Process exit releases native locks automatically; bot tokens and user sessions remain saved.

`test:e2e` is separate from the isolated `test` suite and runs first in `verify`. Missing credentials, provisioning failures, and timeouts fail acceptance rather than skipping tests. Inspect original Telegram diagnostics before rerunning; an ambiguous failure may already have created a remote resource. Never log or commit saved sessions or bot tokens.

Use `setupCollaborationTest` from `test/e2e/helpers/collaboration-fixture.ts` for application workflows and `setupTelegramTest` for lower-level Telegram resources. Both register teardown with the Node test context. Keep scenario-specific transitions and expectations in test files rather than setup helpers.

Select a named live workflow without running the other workflows:

```sh
timeout 300s pnpm test:one --test-name-pattern questions test/e2e/telegram.test.ts
```

Selected workflows create their own prerequisite sessions. Workflows selected together run sequentially and share one Telegram and OMP fixture.

Forum provisioning retries only the explicit test-network RPC rejection `500 CHAT_OCCUPY_LOC_FAILED`, checking for an already-created matching forum before retrying. This policy belongs to the fixture; the application bot's production rate-limit handling is exercised independently.

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

Active mirror disconnects emit `omp-mirror-disconnected` JSON records to the service logs before listener cleanup or recovery. Records retain the exact close reason, timestamp, bot/topic/session identifiers, OMP host identity and generation, listener generation, and whether the connection completed setup. `omp-mirror-reconnect-exhausted` records identify sessions that reach the five-attempt recovery limit. Correlate these records with the existing `reconnect:<sessionId>` background failure diagnostics. Capability URLs and write tokens are not included. These records preserve observed disconnects across bot restarts when service-log retention is enabled; they do not by themselves establish the underlying network or host cause.

Failure diagnostics preserve the original operation error, including multiline OMP discovery messages. Telegram operation failures are logged, and subprocess failure reports retain available exit codes, signals, and killed status. Inspect those original diagnostics rather than treating a generic startup or Telegram failure summary as the cause.

Best-effort Telegram notices, reactions, question-control cleanup, polling retries, and initial-task retries log their original failures. Collab transport and callback failures, idle retirement, Mini App operations, and service control requests also retain local diagnostics. CLI reload preserves the service's multiline error, exit code, and signal; configuration filesystem errors retain their original cause. Expected cancellation, missing-file checks, validation of untrusted input, and promise-chain catches with another error owner remain quiet. Raw relay control frames are not logged.

During new managed-host startup, an `omp collab link` failure with `no active Collab host matches` returns to host discovery until the existing `startupTimeoutMs` deadline. The runtime preserves the last original subprocess error if the deadline expires. If the final discovery probe is killed at that deadline, its error is retained as the original rejection's `cause`, rather than replacing the rejection's exit code and diagnostics. This recovery does not apply to attached hosts, existing managed hosts, or identity-validation failures.

Telegram transport uses [grammY](https://grammy.dev/). API rejections expose `GrammyError.error_code`, `description`, and `parameters`; network failures expose the original failure through `HttpError.error`. Preserve the native error object in server-side diagnostics. Telegram replies retain grammY's safe `HttpError.message`, not the private transport message, which can contain a token-bearing URL. The Node client requires `abort-controller` signals at its API boundary; application background work uses native cancellation.

Managed hosts capture raw PTY output in `dataDir/sessions/SESSION_ID/terminal.log`, rotating to `terminal.log.1` at 1 MiB per file (at most 2 MiB per session). Files are mode 0600 and remain until the session data is removed; restarts append a launch marker. Output includes terminal escape sequences and redraws and may contain prompts, responses, tool output, paths, or secrets. Treat both files as sensitive; do not publish them or render untrusted terminal output directly. Startup failures identify the private log path without forwarding raw output to Telegram or PM2. Already-running supervisors begin logging only when their managed host is next launched.
