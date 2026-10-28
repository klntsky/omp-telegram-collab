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
   pnpm cli create /srv/projects/backend --admin alice --admin bob
   pnpm start
   ```

   `configure` asks for service settings. `bot add` verifies the token and asks for the Mini App short name, which defaults to `app`. `create` registers an existing directory. It does not create or clone a project. Use `pnpm cli setup` for a guided configuration wizard.

4. Put the HTTP service behind an HTTPS reverse proxy. Forward WebSocket upgrades for `/api/socket`. Keep the loopback bind address if the proxy runs on the same machine. Telegram uses long polling, so no webhook is needed.
5. In BotFather, use `/newapp` to create a direct-link Mini App. Match the short name configured above. Set its web URL to the per-bot URL printed at startup, such as `https://your-host.example/?bot=YOUR_NUMERIC_BOT_ID`.

   Optionally enable inline mode for this bot with BotFather's `/setinline` to use Search in the `/skills` picker. Choose a search placeholder when prompted. Inline mode is not required: the picker's normal skill buttons remain available without it. Inline search is bound to the user and topic that opened the picker and expires after ten minutes; reopening `/skills` refreshes the search context without clearing persisted pending selections.

   Skill aliases are registered in group-scoped command menus at startup and refreshed by a 60-second scheduler. Only changed menus are written. Catalog discovery is cached for five minutes per project instance, with concurrent requests sharing one discovery and a 30-second cooldown after failure. Refresh failures log the original diagnostics, preserve existing menus, and do not block bot startup; new groups retain built-in commands. Telegram's 100-command menu limit includes built-ins, so use `/skills` for overflow skills or alias collisions.

   Managed sessions use their loaded skill catalogs; discovery does not reload them or restart active hosts automatically. Older managed hosts without skill-lifecycle support report that a host restart is required. Only when it is safe to interrupt the host, use `/kill`, then submit a prompt to start it again. Attached-host discovery uses the assigned instance settings, not terminal-private loaded skills.

6. Create a Telegram supergroup with Topics enabled. Give the bot Manage Topics and Pin Messages permissions.
7. As a group administrator, send `/setup`. Run the approval command it returns on the service machine.

   ```sh
   pnpm cli approve REQUEST_CODE
   ```

   Approval verifies the group and requester, asks for the project directory and prompt settings, and confirms before adding the requester as a project admin. Requests expire after ten minutes. Adding the bot alone does not assign a project or enable Topics.
8. Send `/new Implement authentication` in the group, then select Open Session in the new topic.

Examples below use `pnpm cli` from this checkout. The build also provides `./dist/cli.js` and the `omp-telegram` executable.

## Manage projects and chats


A project's canonical absolute directory path identifies it. Relative paths and symlinks resolve to that path. There are no separate project aliases or IDs.

```sh
pnpm cli list
pnpm cli show /srv/projects/backend
pnpm cli admin add /srv/projects/backend carol
pnpm cli admin remove /srv/projects/backend bob
pnpm cli chat add /srv/projects/backend --chat -1001111111111
pnpm cli chat add /srv/projects/backend --chat -1002222222222 \
  --all-messages-are-prompts false --users-can-propose-prompts true
pnpm cli chat list /srv/projects/backend
pnpm cli chat remove /srv/projects/backend --chat -1001111111111
```

See [Product](PRODUCT.md#2-projects-and-access) for project identity, shared working files, and chat assignment constraints.

The setup wizard, interactive chat assignment, and request approval ask for both prompt settings. Assigned forums can change them through `/setup`. Scripts can pass `--all-messages-are-prompts true|false` and `--users-can-propose-prompts true|false` to `chat add` or `approve`. Repeating `chat add` updates the assignment; omitted flags preserve existing values. Command menus update on configuration reload.

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

Configuration contains bot tokens, project paths, admins, chat assignments, and service settings. The CLI creates private files and validates updates before replacing them atomically. It preserves ownership and mode. Invalid or unreadable configuration causes an error, not an empty configuration.

Each bot/chat assignment may contain an optional `default_new_topic_skill` string. Configuration validation uses the canonical mentionable-name grammar without trimming, case folding, or alias conversion; catalog existence is checked by `/set_default_new_topic_skill <exact-skill-name>`. Instance admins can run that command from General or a session topic to update the forum default, omit the argument to display it, or use `--clear` to remove it. Bare `clear` remains a valid exact skill name when present in the catalog.

New managed topics persist a snapshot across service restarts and apply it only to their first accepted Telegram prompt or proposal, deduplicated against explicit pending skill selections. General `/p` and `/new` include it in the initial task and freeze it in proposals. Manually created topics apply their snapshot to the first authorized user's accepted Telegram task. Existing topics and attached histories remain unchanged when the forum default changes. Mini App submissions are outside this Telegram composition setting.

Both the file and its parent directory must be writable to change configuration. A service with readable but protected configuration can still run sessions. Protect both against the service account if it must not change them; an administrator can run the CLI under another account.

Runtime data lives separately in `dataDir`, which defaults to a `data` directory beside the YAML. Back up both. Changing `dataDir` selects different state; it does not migrate histories. Startup does not import `.env` files or old configuration formats.

Configuration updates notify the running service and await acknowledgement. Project, admin, chat, and limit changes apply without restarting bots. Bot, listener, and other runtime changes restart the affected components while preserving managed hosts and histories. Mini Apps may need to rejoin. If a saved update fails to apply, the CLI reports that failure. Retry with `pnpm cli reload`.

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

Each successful bot startup posts an online notice in General for enrolled groups. An orderly stop posts a winding-down notice. Failed startup and forced termination cannot send those notices reliably.

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
pnpm check
pnpm test
pnpm build
pnpm smoke
```

`check` typechecks the backend, Mini App, tests, and TypeScript scripts. `test` runs isolated test files with concurrency five.

`smoke` runs CLI, Telegram, gateway, and OMP runtime stages in separate subprocesses. Run a stage with `pnpm smoke:cli`, `pnpm smoke:telegram`, `pnpm smoke:gateway`, or `pnpm smoke:runtime`. Select several with `pnpm smoke telegram gateway`. The CLI stage requires a current build. The runtime stage requires OMP, configured credentials, and enough resources to start within its timeout. Local fixtures need no live Telegram credentials.

Run a focused test file with `pnpm exec tsx --test --test-concurrency=5 test/bot-presets.test.ts`. Run the disposable real-process kill check with `pnpm exec tsx scripts/runtime-kill-smoke.ts`.

Live Telegram verification requires a BotFather token, configured Mini App, HTTPS deployment, and forum groups. Local fixtures cannot verify BotFather settings or Telegram client behavior. Do not stop a service that owns an active coding session solely to test lifecycle notices.

## Debugging

Use `pm2 logs omp-telegram-collab` for deployed service diagnostics. If configuration was saved but not applied, correct the reported error and run `pnpm cli reload`. Reopen Open Session when Telegram launch credentials expire. If capacity is exhausted, close unused Mini Apps or increase the configured limit before selecting Rejoin.

Managed hosts capture raw PTY output in `dataDir/sessions/SESSION_ID/terminal.log`, rotating to `terminal.log.1` at 1 MiB per file (at most 2 MiB per session). Files are mode 0600 and remain until the session data is removed; restarts append a launch marker. Output includes terminal escape sequences and redraws and may contain prompts, responses, tool output, paths, or secrets. Treat both files as sensitive; do not publish them or render untrusted terminal output directly. Startup failures identify the private log path without forwarding raw output to Telegram or PM2. Already-running supervisors begin logging only when their managed host is next launched.
