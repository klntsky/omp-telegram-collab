# Development

For behavior and permissions, see [Product](PRODUCT.md). For component ownership and trust boundaries, see [Architecture](ARCHITECTURE.md).

## Set up


1. Install Node.js 22.13 or newer, pnpm, and OMP. Configure OMP's model credentials for the account that will run the service.
2. Create a bot with BotFather. Keep its token private.
3. Clone this repository, build it, and register your bot and project directory.

   ```sh
   git clone https://github.com/klntsky/omp-telegram-collab.git
   cd omp-telegram-collab
   pnpm install
   pnpm build
   pnpm cli configure
   pnpm cli bot add
   pnpm cli create /srv/projects/backend
   pnpm start
   ```

   `configure` asks for service settings. `bot add` verifies the token and asks for the Mini App short name, which defaults to `app`. `create` registers an existing directory. It does not create or clone a project. Use `pnpm cli setup` for a guided configuration wizard.

4. Put the HTTP service behind an HTTPS reverse proxy. Forward WebSocket upgrades for `/api/socket`. Keep the loopback bind address if the proxy runs on the same machine. Telegram uses long polling, so no webhook is needed.
5. In BotFather, use `/newapp` to create a direct-link Mini App. Match the short name configured above. Set its web URL to the per-bot URL printed at startup, such as `https://your-host.example/?bot=YOUR_NUMERIC_BOT_ID`.

   Optionally enable inline mode for this bot with BotFather's `/setinline` to use Search in the `/skills` picker. Choose a search placeholder when prompted. Inline mode is not required: the picker's normal skill buttons remain available without it. Inline search is bound to the user and topic that opened the picker and expires after ten minutes; reopening `/skills` refreshes the search context without clearing persisted pending selections.

   The last successful per-instance skill catalogs are stored in the runtime SQLite database under `dataDir`. A background menu refresh runs at startup and every 60 seconds. Runtime discovery is cached for five minutes per project instance, with concurrent requests sharing one discovery and a 30-second cooldown after failure. Refresh failures retain their original diagnostics in service logs. See [Product](PRODUCT.md) for startup menu behavior and live-session validation.

   Managed sessions use their loaded skill catalogs; discovery does not reload them or restart active hosts automatically. Older managed hosts without skill-lifecycle support report that a host restart is required. Only when it is safe to interrupt the host, use `/kill`, then submit a prompt to start it again. Lifecycle-extension fixes take effect when a host starts; existing hosts retain their loaded extension code. Attached-host discovery uses the assigned instance settings, not terminal-private loaded skills.

   Two-way topic/session title synchronization uses OMP's native session-name API through the managed host's private lifecycle control socket. Hosts started before title-control support need a host restart before Telegram renames can apply; restarting only the bot does not reload a running host's extension. Terminal-owned attached hosts without that control extension cannot accept Telegram renames and report the original control diagnostic; their OMP titles can still be mirrored to Telegram.

6. Create a Telegram supergroup with Topics enabled. Give the bot Manage Topics and Pin Messages permissions.
7. As a group administrator, send `/setup`. Run the approval command it returns on the service machine.

   ```sh
   pnpm cli approve REQUEST_CODE
   ```

   Approval verifies the group and the requester's current owner or administrator status, asks for the project directory and prompt settings, and confirms the assignment. The requester does not need a username. Requests expire after ten minutes. Adding the bot alone does not assign a project or enable Topics.
8. Send `/new Implement authentication` in the group, then select OPEN AGENT in the new topic.

Examples below use `pnpm cli` from this checkout. The build also provides `./dist/cli.js` and the `omp-telegram` executable.

## Manage projects and chats


A project's canonical absolute directory path identifies it. Relative paths and symlinks resolve to that path. There are no separate project aliases or IDs.

```sh
pnpm cli list
pnpm cli show /srv/projects/backend
pnpm cli chat add /srv/projects/backend --chat -1001111111111
pnpm cli chat add /srv/projects/backend --chat -1002222222222 \
  --all-messages-are-prompts false --users-can-propose-prompts true
pnpm cli chat list /srv/projects/backend
pnpm cli chat remove /srv/projects/backend --chat -1001111111111
```

See [Product](PRODUCT.md#2-projects-and-access) for project identity, shared working files, and chat assignment constraints.

The setup wizard, interactive chat assignment, and request approval ask for both prompt settings. Assigned forums change them through `/settings`; `/setup` completes enrollment and opens that panel. Scripts can pass `--all-messages-are-prompts true|false` and `--users-can-propose-prompts true|false` to `chat add` or `approve`. Repeating `chat add` updates the assignment; omitted flags preserve existing values. Command menus update on configuration reload.

Register more bots with `pnpm cli bot add`. `bot list` shows numeric IDs without tokens. With multiple bots, pass `--bot ID` on scripted chat commands. Noninteractive registration accepts `--token-stdin` or `--token-env VARIABLE` and optional `--mini-app-short-name NAME`. The environment option copies the token into configuration; it does not retain an environment reference.

For unattended enrollment, use `pnpm cli approve REQUEST_CODE --path /srv/projects/backend --yes`.

Remove all chat assignments before running `pnpm cli remove PATH`. Review the [removal behavior](PRODUCT.md#2-projects-and-access) before changing a project's registration.

## Configuration and deployment


The CLI manages `$XDG_CONFIG_HOME/omp-telegram/config.yaml`, or `~/.config/omp-telegram/config.yaml` by default. Every command accepts `--config PATH` before or after the command.

```sh
pnpm cli --config /etc/omp-telegram/config.yaml setup
pnpm cli --config /etc/omp-telegram/config.yaml start
pnpm cli show /srv/projects/backend --config /etc/omp-telegram/config.yaml
```

Configuration contains bot tokens, project paths, chat assignments, and service settings. The CLI creates private files and validates updates before replacing them atomically. It preserves ownership and mode. Invalid or unreadable configuration causes an error, not an empty configuration.

Manage group owners and administrators through Telegram's native group settings. `/list_admins` reads the current human administrator roster. The CLI and `/settings` do not maintain a separate administrator list. See [Product](PRODUCT.md#12-prompts-and-permissions) for authorization behavior.

The current configuration format has no `bots[].admins` or `instances[path].admins` fields. Remove those obsolete keys before starting this version; strict validation rejects them. Old SQLite topic grants are never read or converted into Telegram roles. Promote intended operators in Telegram before the cutover.

Pending initial tasks from before this cutover have no recorded authorizing administrator. Their next admission is cancelled; submit them again after updating group roles. Saved conversations and already submitted tasks remain intact.

Each bot/chat assignment may contain an optional `default_new_topic_skill` string. Configuration validation uses the canonical mentionable-name grammar without trimming, case folding, or alias conversion. The default-skill picker in `/settings` checks catalog existence before saving.

See [Product](PRODUCT.md#12-prompts-and-permissions) for default-skill application and topic snapshot behavior.

Both the file and its parent directory must be writable to change configuration. A service with readable but protected configuration can still run sessions. Protect both against the service account if it must not change them; an administrator can run the CLI under another account.

Runtime data lives separately in `dataDir`, which defaults to a `data` directory beside the YAML. Back up both. Changing `dataDir` selects different state; it does not migrate histories. Startup does not import `.env` files or old configuration formats.

Worktree-backed managed sessions require Git and a configured repository with a valid `HEAD`. Configure worktree placement and source-checkout cleanup in OMP's worktree settings. The service invokes OMP's native command rather than creating its own detached checkouts. Keep the configured repository and resulting worktrees available across service restarts, and back up worktree contents alongside runtime data. Closing topics, killing hosts, and stopping the service do not delete worktrees. Inspect and remove unused worktrees only after their sessions no longer need them.

Configuration updates notify the running service and await acknowledgement. Project, chat, and limit changes apply without restarting bots. Bot, listener, and other runtime changes restart the affected components while preserving managed hosts and histories. Mini Apps may need to rejoin. If a saved update fails to apply, the CLI reports that failure. Retry with `pnpm cli reload`.

`/terminate` writes top-level `terminated: true`. To resume, an authorized operator removes that entry from the YAML; no restart or Telegram resume command is required. Input handling checks file metadata before dispatch and parses YAML only when the file changes. The existing configuration watcher also applies edits while idle. Keep the configuration and its parent writable if Telegram admins must be able to terminate the service.

### Scripted configuration

`configure` accepts `--public-url`, `--host`, `--port`, `--data-dir`, `--omp-executable`, repeated `--omp-arg`, `--clear-omp-args`, `--max-sessions`, `--startup-timeout-ms`, and `--relay-url`. Use `--relay-url -` to clear the relay. OMP arguments are literal strings, not shell commands.

Defaults are loopback, port 3000, executable `omp`, eight resident managed hosts, and a 60000 ms startup timeout. The public URL must be an HTTPS origin without credentials, path, query, or fragment.

### Run under PM2

Build and configure first. Do not run a second `pnpm start` alongside PM2.

```sh
pm2 start "$(command -v node)" --name omp-telegram-collab --cwd "$PWD" \
  --interpreter none --no-treekill --kill-timeout 75000 --restart-delay 2000 -- \
  "$PWD/dist/cli.js" --config /etc/omp-telegram/config.yaml start
pm2 save
```

`--no-treekill` is required. OMP hosts have detached supervisors; PM2's recursive termination can abort active tasks with `Request was aborted`. To update or restart an existing entry, use:

```sh
pnpm build
pm2 restart omp-telegram-collab --no-treekill
pm2 save
```

Keep tokens out of PM2's launch environment. Use `pm2 logs omp-telegram-collab` for diagnostics. Run `pm2 startup` and follow its instructions if startup persistence is not enabled. Do not restart unrelated applications.

Restarting the bot does not reload lifecycle extensions in surviving OMP hosts. Existing hosts without cancellable retirement support remain running instead of receiving an unsafe retirement request. An explicit retirement operation on an unsupported host reports that its lifecycle extension needs updating. Let active work finish before using `/kill` to replace a host when its extension needs updating. Do not clear retirement descriptors or remove grant files manually to bypass admission; use the runtime's cancellation and restart recovery paths.

See [Product](PRODUCT.md) for lifecycle readiness and Telegram notice behavior, and [Architecture](ARCHITECTURE.md) for service ownership and shutdown boundaries.

`Service timing` log entries report measured milliseconds for runtime acquire, store open, session validation, each bot's initialization and first successful poll, HTTP bind, launch-to-first-poll-ready, ready-to-notification completion, and shutdown notices/drain/runtime/store/total. These are operation durations, not estimates; overlapping shutdown phases must not be summed. Ready-to-notification includes marker I/O and all notification attempts (including failures or cancellation), not proof that Telegram displayed every message. Initial launch also logs process-start-to-ready and the combined process-start-to-launch bootstrap/dependencies/config interval. This combined interval uses Node's process time origin; pure static module-loading time is not separately measurable here. In-process configuration replacement omits the process-start timings.

The online message retains end-to-end restart time from the preceding orderly shutdown's start. `dataDir/restart-timing.json` is the single JSON timing marker. Orderly process exit records the predecessor exit timestamp synchronously; the next process logs `process replacement gap` from that exit to Node's process start (`performance.timeOrigin`), separate from bootstrap and launch phases. In-process configuration replacement retains the end-to-end notice but has no process-exit gap. A forced kill cannot record a trustworthy exit timestamp. The marker is consumed by the tracked online task before notification delivery; close drains that task before writing a new shutdown marker, so an old task cannot delete the new marker. Inspect original errors in logs if marker reads/writes or notice delivery fail.

## Attach a local session


1. Enable control sharing with `/collab` in the OMP terminal.
2. Run `omp collab list --json` on the service machine to find the host instance ID.
3. Send `/attach INSTANCE_ID` in the assigned group. The host's working directory must match that group's project directory.

The OMP host ID is not the project directory used by this service. Do not paste Collab capability links into Telegram. Attached hosts remain owned by their terminal and survive service shutdown. `/kill` does terminate them; restart locally and attach the new host to reconnect.

## Create model presets

Create presets locally with OMP's `/modelpreset save <name>`.

## Modify the Mini App

The editable Collab Web client lives in `web/src`. `web/upstream.json` records its upstream revision, and `web/LICENSE.upstream` preserves the license. Authentication and WebSocket transport are local adaptations. Run `pnpm build` after changes.

## Verify changes

```sh
pnpm verify
```

`verify` requires typechecking, the isolated suite, a production build, and all integration stages to pass, in that order. Run it on the pull request revision in a disposable checkout, not on master. Use an explicit outer timeout, for example `timeout 600s pnpm verify`; timeout is failure, not a skip or pass.

`check` typechecks the backend, Mini App, tests, and TypeScript scripts. `test` runs isolated test files with concurrency five; mocked collaborators only establish local behavior, not compatibility with the external service they imitate. `test:integration` builds production artifacts and runs `smoke`.

`smoke` runs CLI, Telegram, gateway, and OMP runtime stages in separate subprocesses. Run a stage with `pnpm smoke:cli`, `pnpm smoke:telegram`, `pnpm smoke:gateway`, or `pnpm smoke:runtime`. Select several with `pnpm smoke telegram gateway`. The CLI stage requires a current build. The runtime stage requires an installed OMP and enough resources to start within its timeout. Its model-executing lifecycle checks also require configured model credentials. Local fixtures need no live Telegram credentials.

The Telegram stage uses a local fake Telegram HTTP service; the gateway stage uses real loopback HTTP/WebSocket transport but substitutes the host connector. Neither establishes live Telegram or actual OMP compatibility. The runtime stage uses an actual OMP subprocess and encrypted Collab traffic through a local forwarding relay; it does not establish compatibility with the production relay. Passing local integration checks is not evidence that BotFather settings, deployed networking, or Telegram clients work.

Run one file or select a test by name (a regular expression), with flags before paths:

```sh
timeout 60s pnpm test:one test/auth.test.ts
timeout 60s pnpm test:one --test-name-pattern '^WebSocket tickets are single-use and expire at their boundary$' test/auth.test.ts
```

`test:one` accepts Node test-runner flags and one or more paths without adding the full-suite glob. Run the disposable real-process kill check with `timeout 180s pnpm exec tsx scripts/runtime-kill-smoke.ts`.

Live Telegram verification requires a BotFather token, configured Mini App, HTTPS deployment, and forum groups. Local fixtures cannot verify BotFather settings or Telegram client behavior. Do not stop a service that owns an active coding session solely to test lifecycle notices.

## Debugging

Use `pm2 logs omp-telegram-collab` for deployed service diagnostics. If configuration was saved but not applied, correct the reported error and run `pnpm cli reload`. Reopen OPEN AGENT when Telegram launch credentials expire. If capacity is exhausted, close unused Mini Apps or increase the configured limit before selecting Rejoin.

Use `/status` in General or the affected topic before inspecting process logs; see [Product](PRODUCT.md) for its diagnostic scope and interpretation. Status observations reset with the bot process, so use the service logs when investigating failures from a previous process.

Failure diagnostics preserve the original operation error, including multiline OMP discovery messages. Telegram operation failures are logged, and subprocess failure reports retain available exit codes, signals, and killed status. Inspect those original diagnostics rather than treating a generic startup or Telegram failure summary as the cause.

During new managed-host startup, an `omp collab link` failure with `no active Collab host matches` returns to host discovery until the existing `startupTimeoutMs` deadline. The runtime preserves the last original subprocess error if the deadline expires. This recovery does not apply to attached hosts, existing managed hosts, or identity-validation failures.

Telegram transport uses [grammY](https://grammy.dev/). API rejections expose `GrammyError.error_code`, `description`, and `parameters`; network failures expose the original failure through `HttpError.error`. Preserve the native error object in server-side diagnostics. Telegram replies retain grammY's safe `HttpError.message`, not the private transport message, which can contain a token-bearing URL. The Node client requires `abort-controller` signals at its API boundary; application background work uses native cancellation.

Managed hosts capture raw PTY output in `dataDir/sessions/SESSION_ID/terminal.log`, rotating to `terminal.log.1` at 1 MiB per file (at most 2 MiB per session). Files are mode 0600 and remain until the session data is removed; restarts append a launch marker. Output includes terminal escape sequences and redraws and may contain prompts, responses, tool output, paths, or secrets. Treat both files as sensitive; do not publish them or render untrusted terminal output directly. Startup failures identify the private log path without forwarding raw output to Telegram or PM2. Already-running supervisors begin logging only when their managed host is next launched.
