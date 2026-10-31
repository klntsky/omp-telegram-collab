# Development

For behavior and permissions, see [Product](PRODUCT.md). For component ownership and trust boundaries, see [Architecture](ARCHITECTURE.md).

## Set up


1. Install Node.js 22.13 or newer, pnpm, and [OMP](https://github.com/can1357/oh-my-pi). Configure OMP's model credentials for the account that will run the bot.
2. Open [BotFather](https://t.me/BotFather) in Telegram and send `/newbot`.
   1. Enter a display name for your bot.
   2. Enter an available username ending in `bot`.
   3. Save the API token BotFather returns. Keep it private. You will enter it in `pnpm cli bot add`.
3. Clone and build this project.

   ```sh
   git clone https://github.com/klntsky/omp-telegram-collab.git
   cd omp-telegram-collab
   pnpm install
   pnpm build
   ```

4. Configure the service, register the bot, and choose an existing project directory. Replace `/path/to/project` with your directory.

   `pnpm cli configure` explains the Mini App and asks whether to enable it. Telegram-only is the default. You can send prompts and images, read replies, and answer agent questions in Telegram. Enable the Mini App if you also want a live transcript, tool details, and subagent controls.

   If you enable it, enter your public HTTPS address, such as `https://omp.example.com`, at the `Public HTTPS origin` prompt. Set the listen host and port for your reverse proxy or tunnel.

   ```sh
   pnpm cli configure
   pnpm cli bot add
   pnpm cli create /path/to/project
   pnpm start
   ```

   Enter the BotFather token when `bot add` asks. If you enabled the Mini App, keep the default short name, `app`.

   <details>
   <summary>Example CLI commands and output</summary>

   These examples use filler values. Output excerpts omit package-manager headers and unrelated prompts. Never paste a real bot token into documentation.

   ```text
   $ pnpm cli configure
   The optional Mini App provides a live transcript, tool details, and subagent controls. It requires a public HTTPS origin and a BotFather Mini App for each bot. Telegram-only mode needs neither.
   Enable Mini App? [y/N]: n
   Service configuration saved to /home/operator/.config/omp-telegram/config.yaml.

   $ pnpm cli bot add
   Bot token (hidden):
   Added @example_omp_bot (123456789).

   $ pnpm cli create /srv/projects/backend
   Created /srv/projects/backend

   $ pnpm cli list
   /srv/projects/backend
     chats: (none)
   ```

   </details>

5. If you enabled the Mini App, choose how to expose the service over HTTPS.

   <details>
   <summary>Option 1: Use cloudflared</summary>

   You need a Cloudflare account and at least one domain added to that account with DNS managed by Cloudflare. This example uses `omp.example.com`. Replace `example.com` with your domain.

   1. In the [Cloudflare dashboard](https://dash.cloudflare.com/), open **Networking > Tunnels** and select **Create Tunnel**.
   2. Name the tunnel `omp-telegram`.
   3. Select your operating system and architecture. Follow the displayed commands to install `cloudflared` and run it as a service on the machine running the bot. On Linux, the service installation command looks like this:

      ```sh
      sudo cloudflared service install <TUNNEL_TOKEN>
      ```

      Use the token provided by Cloudflare and keep it private. The service starts the tunnel automatically after reboot.

   4. Once the tunnel connects, select **Continue**.
   5. Under the tunnel's **Routes**, select **Add route > Published application**.
   6. Set the subdomain to `omp` and select your domain.
   7. Set the service URL to `http://127.0.0.1:3000`, matching the bot's default listen address. If you configured another host or port, use that address.
   8. Save the route. Cloudflare serves `https://omp.example.com` over HTTPS and forwards HTTP and WebSocket traffic to the bot.
   9. Set `Public HTTPS origin` to `https://omp.example.com` in `pnpm cli configure`. Use the complete per-bot URL printed at startup for BotFather, such as `https://omp.example.com/?bot=123456789`.

   The hostname stays the same across bot and tunnel restarts. Keep the bot and the `cloudflared` service running to make the Mini App available.

   See [Cloudflare's tunnel setup guide](https://developers.cloudflare.com/tunnel/get-started/) for platform-specific installation commands.

   </details>

   <details>
   <summary>Option 2: Set up HTTPS manually</summary>

   1. Point your hostname, such as `omp.example.com`, at the server running your reverse proxy.
   2. Configure the proxy to serve that hostname over HTTPS with a publicly trusted certificate.
   3. Forward requests to the bot's configured listen address, which defaults to `http://127.0.0.1:3000`. Use an address reachable from the proxy if it runs on another machine.
   4. Enable WebSocket forwarding for `/api/socket`, preserving the request path and query string.
   5. Set `Public HTTPS origin` to `https://omp.example.com` in `pnpm cli configure`.
   6. Open the complete per-bot URL printed at startup in a browser on your phone using mobile data. Confirm that the page loads over HTTPS with a valid certificate. Complete the Telegram connection check below after registering the Mini App.

   </details>

6. If you enabled the Mini App, send `/newapp` in BotFather to register it.
   1. Select the bot you created, or send its `@username`.
   2. Enter an app title, such as `OMP Telegram Collab`.
   3. Enter a description, such as `Run coding sessions from Telegram`.
   4. Download the [prepared app photo](assets/botfather-mini-app.png) and upload it when BotFather asks for a photo. It is already 640 × 360 pixels.
   5. Send `/empty` to skip the optional GIF.
   6. For the web URL, paste the complete HTTPS URL printed by `pnpm start`, including `?bot=...`. It looks like `https://omp.example.com/?bot=123456789`.
   7. For the short name, enter `app`, matching the value you accepted in `pnpm cli bot add`.
   8. BotFather returns the Telegram launch link, such as `https://t.me/your_bot/app`.

   The topic buttons use this named app's direct link to select the session.

7. Add the bot to a Telegram supergroup with Topics enabled. Promote it to administrator with Manage Topics and Pin Messages permissions. Keep BotFather's default privacy setting. Administrator bots receive ordinary group messages.
8. As a group administrator, send `/setup`. Run the approval command it returns on the service machine.

   The command includes the service config path and defaults `--path` to the bot process's working directory. Change `--path` to your project directory if the bot runs from its own checkout. Approval asks for prompt settings and confirmation, not a directory when `--path` is supplied. Requests expire after ten minutes.

   <details>
   <summary>Example Telegram setup messages</summary>

   All names, IDs, paths, and request codes below are filler values. This example assumes the bot runs in `/srv/projects/backend`.

   When the bot joins the group:

   ```text
   A current group administrator can run /setup to request instance assignment from the local operator.
   ```

   If Topics or bot permissions are missing:

   ```text
   Use a supergroup with Topics enabled, then grant this bot Manage Topics and Pin Messages permissions.
   ```

   After a group administrator sends `/setup` in an unassigned forum:

   ```text
   Setup requested. Ask the local operator to approve within 10 minutes:
   omp-telegram --config '/home/operator/.config/omp-telegram/config.yaml' approve EXAMPLE_CODE --path '/srv/projects/backend'
   The command defaults to the bot's working directory. Change --path to use another instance directory.
   ```

   After local approval:

   ```text
   Setup approved. This forum is connected to OMP. Create a topic to start a coding session.
   ```

   </details>

   <details>
   <summary>Example local approval command and output</summary>

   Run the command from the bot on the service machine. If `omp-telegram` is not on your shell's `PATH`, use `pnpm cli` from the built checkout instead. This example uses filler values and accepts the default prompt settings by pressing Enter.

   ```text
   $ pnpm cli --config '/home/operator/.config/omp-telegram/config.yaml' approve EXAMPLE_CODE --path '/srv/projects/backend'
   Verified bot @example_omp_bot (123456789)
   Verified forum Example project (-1001234567890)
   Verified requester 42, current group administrator.
   Treat all session-topic messages as prompts? true = ordinary messages, false = /p only [true]:
   Allow non-admin users to propose prompts for administrator approval? [false]:
   Connect this forum to /srv/projects/backend? [y/N] yes
   Approved EXAMPLE_CODE: /srv/projects/backend
   ```

   </details>

9. Send `/new <your task>` in the group to start a session. Replace `<your task>` with what you want the agent to do.
10. Verify the connection in Telegram.
    1. Send a prompt asking the agent to reply with a short greeting. Confirm that its reply appears in the topic.
    2. If you enabled the Mini App, switch your phone to mobile data and open the topic's **OPEN AGENT** button. Confirm that the Mini App loads the session transcript and the greeting.
    3. If you enabled the Mini App, keep it open and send another prompt from a second Telegram client. Confirm that the new reply appears in the open Mini App. This checks live updates through the WebSocket connection.

Examples below use `pnpm cli` from this checkout. The build also provides `./dist/cli.js` and the `omp-telegram` executable.

   Optionally enable inline mode for this bot with BotFather's `/setinline` to use Search in the `/skills` picker. Choose a search placeholder when prompted. Inline mode is not required: the picker's normal skill buttons remain available without it. Inline search is bound to the user and topic that opened the picker and expires after ten minutes; reopening `/skills` refreshes the search context without clearing persisted pending selections.

   The last successful per-instance skill catalogs are stored in the runtime SQLite database under `dataDir`. A background menu refresh runs at startup and every 60 seconds. Skill discovery is cached for five minutes per project instance, with concurrent requests sharing one discovery and a 30-second cooldown after failure. Preset-name hints refresh independently from each project's OMP configuration. Refresh failures retain their original diagnostics in service logs. See [Product](PRODUCT.md) for startup menu behavior and live-session validation.

   Managed sessions use their loaded skill catalogs; discovery does not reload them or restart active hosts automatically. Older managed hosts without skill-lifecycle support report that a host restart is required. Only when it is safe to interrupt the host, use `/kill`, then submit a prompt to start it again. Lifecycle-extension fixes take effect when a host starts; existing hosts retain their loaded extension code. Attached-host discovery uses the assigned instance settings, not terminal-private loaded skills.

   Two-way topic/session title synchronization uses OMP's native session-name API through the managed host's private lifecycle control socket. Hosts started before title-control support need a host restart before Telegram renames can apply; restarting only the bot does not reload a running host's extension. Terminal-owned attached hosts without that control extension cannot accept Telegram renames and report the original control diagnostic; their OMP titles can still be mirrored to Telegram.

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

Each bot/chat assignment may contain an optional `create_topic_worktrees` boolean, which defaults to `false` when omitted. Administrators can toggle it per forum through `/settings`, or an operator can set it under `instances[project path].chats[]` in YAML. See [Product](PRODUCT.md#11-sessions-and-commands) for automatic worktree creation, branch names, and session exclusions.

Each bot/chat assignment may set `typing_indicators` to `disabled`, `streaming`, or `inference`; omission selects `disabled`. Administrators can change it through `/settings`, or operators can edit `instances[project path].chats[]` in YAML and reload. See [Product](PRODUCT.md#12-prompts-and-permissions) for indicator behavior.

Both the file and its parent directory must be writable to change configuration. A service with readable but protected configuration can still run sessions. Protect both against the service account if it must not change them; an administrator can run the CLI under another account.

Runtime data lives separately in `dataDir`, which defaults to a `data` directory beside the YAML. Back up both. Changing `dataDir` selects different state; it does not migrate histories. Startup does not import `.env` files or old configuration formats.

Worktree-backed managed sessions require Git and a configured repository with a valid `HEAD`. Configure worktree placement and source-checkout cleanup in OMP's worktree settings. The service invokes OMP's native command rather than creating its own detached checkouts. Keep the configured repository and resulting worktrees available across service restarts, and back up worktree contents alongside runtime data. Closing topics, killing hosts, and stopping the service do not delete worktrees. Inspect and remove unused worktrees only after their sessions no longer need them.

Configuration updates notify the running service and await acknowledgement. Project, chat, and limit changes apply without restarting bots. Bot, listener, and other runtime changes restart the affected components while preserving managed hosts and histories. Mini Apps may need to rejoin. If a saved update fails to apply, the CLI reports that failure. Retry with `pnpm cli reload`.

`/terminate` writes top-level `terminated: true`. To resume, an authorized operator removes that entry from the YAML; no restart or Telegram resume command is required. Input handling checks file metadata before dispatch and parses YAML only when the file changes. The existing configuration watcher also applies edits while idle. Keep the configuration and its parent writable if Telegram admins must be able to terminate the service.

### Scripted configuration

`configure` accepts `--public-url`, `--host`, `--port`, `--data-dir`, `--omp-executable`, repeated `--omp-arg`, `--clear-omp-args`, `--max-sessions`, `--startup-timeout-ms`, and `--relay-url`. Use `--relay-url -` to clear the relay. OMP arguments are literal strings, not shell commands.

Defaults are Telegram-only operation, loopback, port 3000, executable `omp`, eight resident managed hosts, and a 60000 ms startup timeout. An empty `publicUrl` selects Telegram-only operation. To enable the Mini App, configure an HTTPS origin without credentials, path, query, or fragment. Each bot then needs a `miniAppShortName` matching its BotFather registration. Reconfigure with `pnpm cli configure` to change modes.

For scripts, use `pnpm cli configure --public-url ''` for Telegram-only operation or `pnpm cli configure --public-url https://omp.example.com` to enable the Mini App. Enabling supplies `app` as the short name for existing bots that have none; register that name in BotFather. Existing short names are retained when changing modes so registered launch links keep working when re-enabled.

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

## Open a topic in your terminal

Make the built `omp-telegram` executable available on your shell's `PATH` with `pnpm link --global` from the checkout. If pnpm asks you to configure its global executable directory, run `pnpm setup` and open a new terminal.

1. As a group administrator, send `/cli` in an open session topic.
2. Copy the command using the reply's copy button.
3. Run it in an interactive terminal on the service machine as the service account.

   ```sh
   omp-telegram session join --chat -1001234567890 --topic 42
   ```

   From a source checkout, use `pnpm cli session join --chat -1001234567890 --topic 42`.

For a custom service configuration, supply its local path:

```sh
omp-telegram --config /etc/omp-telegram/config.yaml session join --chat -1001234567890 --topic 42
```

The running service resolves the chat/topic pair through its private `control.sock`. The command requires exactly one enrolled, assigned, open session. A stopped managed host resumes its saved history; an unavailable attached host reports its original failure. OMP runs in the foreground. Leaving its guest client keeps the shared host running.

The local connection protects the host from idle retirement while your terminal client is open. A service restart or configuration change that replaces the service closes the client connection. Run the copied command again to reconnect.

The copied command contains public identifiers. The Unix socket is accessible only to the service account. The resolved Collab capability is passed to `omp join` locally and may be visible through local process inspection. Protect access to that account and machine.

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

Live Telegram verification requires a BotFather token and forum groups. Mini App verification also requires its BotFather registration and HTTPS deployment. Local fixtures cannot verify BotFather settings or Telegram client behavior. Keep services that own active coding sessions running while testing lifecycle notices elsewhere.

## Debugging

Use `pm2 logs omp-telegram-collab` for deployed service diagnostics. If configuration was saved but not applied, correct the reported error and run `pnpm cli reload`. The Mini App exchanges fresh Telegram launch data once for a long-lived backend credential, cached in memory and session storage per launch and scoped to the bot/session. It reuses that credential for reloads and automatic reconnects, including after service restarts; elapsed launch age alone does not require reopening Telegram. Credentials are signed using the bot token, bind the bot/session/user and session generation, and have no time expiry. The backend refreshes membership on reconnect, before writes, and periodically for active sockets, revoking access when membership is lost; reads reuse established authorization. Backend and network failures preserve their original diagnostics. If capacity is exhausted, close unused Mini Apps or increase the configured limit before selecting Rejoin.

Use `/status` in General or the affected topic before inspecting process logs; see [Product](PRODUCT.md) for its diagnostic scope and interpretation. Status observations reset with the bot process, so use the service logs when investigating failures from a previous process.

Failure diagnostics preserve the original operation error, including multiline OMP discovery messages. Telegram operation failures are logged, and subprocess failure reports retain available exit codes, signals, and killed status. Inspect those original diagnostics rather than treating a generic startup or Telegram failure summary as the cause.

During new managed-host startup, an `omp collab link` failure with `no active Collab host matches` returns to host discovery until the existing `startupTimeoutMs` deadline. The runtime preserves the last original subprocess error if the deadline expires. This recovery does not apply to attached hosts, existing managed hosts, or identity-validation failures.

Telegram transport uses [grammY](https://grammy.dev/). API rejections expose `GrammyError.error_code`, `description`, and `parameters`; network failures expose the original failure through `HttpError.error`. Preserve the native error object in server-side diagnostics. Telegram replies retain grammY's safe `HttpError.message`, not the private transport message, which can contain a token-bearing URL. The Node client requires `abort-controller` signals at its API boundary; application background work uses native cancellation.

Managed hosts capture raw PTY output in `dataDir/sessions/SESSION_ID/terminal.log`, rotating to `terminal.log.1` at 1 MiB per file (at most 2 MiB per session). Files are mode 0600 and remain until the session data is removed; restarts append a launch marker. Output includes terminal escape sequences and redraws and may contain prompts, responses, tool output, paths, or secrets. Treat both files as sensitive; do not publish them or render untrusted terminal output directly. Startup failures identify the private log path without forwarding raw output to Telegram or PM2. Already-running supervisors begin logging only when their managed host is next launched.
