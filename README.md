# OMP Telegram Collab

Run [OMP](https://github.com/can1357/oh-my-pi) coding sessions from Telegram forum topics on your own machine. Telegram, the optional Mini App, and the local OMP terminal connect to the same session.

![OMP Telegram Collab conversations organized into Telegram forum topics](assets/telegram-topics.jpg)

- Give each topic its own conversation and saved history.
- Send prompts and answer agent questions in Telegram or the Mini App.
- Attach existing local OMP sessions.
- Share project directories across groups with configurable prompt approval.
- Edit the included Collab Web client without an iframe.

## OMP feature coverage

✅ Available in Telegram · 📱 Mini-app only · ❌ No remote equivalent.

| Support level | OMP feature | Use from Telegram |
| --- | --- | --- |
| ✅ | Create a session (`/new`) | `/new <task>` creates a topic and starts its session. |
| 📱 | Inspect session information (`/session`) | Telegram `/session` opens the Mini App for the topic's session. |
| ✅ | Join a shared session in a terminal (`omp join`) | `/cli` gives administrators a copyable command to join the topic's host from the bot's machine. |
| ✅ | Resume saved session history (`/resume`) | Send a prompt in an existing managed topic to resume its history. |
| ✅ | Rename a session (`/rename`) | Rename the Telegram topic to update its managed OMP session title. Attached hosts must be renamed in their terminal. |
| ❌ | Move a session or manage workspace directories (`/move`, `/add-dir`, `/remove-dir`, `/dirs`) | No dedicated workspace controls. |
| ❌ | Branch, rewind, fork, or switch history branches (`/branch`, `/rewind`, `/fork`, `/tree`) | No history mutation controls. |
| ❌ | Reset context, delete a session, refresh provider state, or retry a failed turn (`/clear`, `/delete`, `/fresh`, `/retry`) | No equivalent controls. |
| ✅ | Move a session into a worktree (`/wt`, `/worktree`) | `/worktree [branch]` invokes OMP's native operation, keeping the topic's conversation and carrying changes according to OMP's settings. In General, it creates a topic first. |
| ✅ | Share a running session through Collab (`/collab`, `omp collab`) | `/attach INSTANCE_ID` creates a topic connected to an existing local host. |
| 📱 | Leave or join a shared Collab session (`/leave`, `/join`) | Open `/session`, then use Leave or Rejoin for that topic's connection. This does not terminate the host. |
| ❌ | Create arbitrary Collab share links or join arbitrary rooms (`/collab`, `/join`, `omp collab`, `omp join`) | No remote link-creation or arbitrary-room interface. |
| ✅ | Submit text prompts | `/p <prompt>`, ordinary messages when enabled, or the Mini App composer. Mini App prompts also appear in the topic. |
| ✅ | Submit image prompts | Send photos or supported image documents in Telegram, with `/p` when required by prompt policy. The Mini App composer has no upload control. |
| ✅ | Answer agent questions | Use Telegram option buttons, Other, or Cancel; the Mini App also offers option buttons, a text editor, and Cancel. Mini App answers require control permission. |
| ✅ | Interrupt the current turn | `/stop` or the Mini App Stop button. This does not freeze all agents. |
| ✅ | Force-kill a session host | `/kill` preserves managed history; a later prompt can resume it. |
| ❌ | Orderly exit or same-flags restart (`/exit`, `/quit`, `/q`, `/restart`) | `/kill` is forceful termination, not these lifecycle operations. |
| ✅ | Read agent replies | Replies are mirrored into the topic and streamed in the Mini App. |
| 📱 | Inspect the full live transcript and tool calls | Open `/session` to inspect tool arguments, results, partial output, and expandable tool details. |
| 📱 | Inspect thinking and message metadata | Expand disclosures in the Mini App transcript. |
| 📱 | Inspect subagent roster and activity (`/hub`, `/subagents`) | Open the Mini App agent rail to see status, current tool or intent, and last activity. |
| 📱 | Read a subagent's transcript (`/hub`, `/subagents`) | Select an agent to open its drawer. Transcript access requires an available session file. Viewers can read it too. |
| 📱 | Chat with a subagent (`/hub`, `/subagents`) | Send a message from its Mini App drawer. Requires control permission and a live connection. |
| 📱 | Kill a running subagent (`/hub`, `/subagents`) | Use Kill in its Mini App drawer. Requires control permission. |
| 📱 | Revive a parked or aborted subagent (`/hub`, `/subagents`) | Use Revive in its Mini App drawer. Requires control permission. |
| 📱 | Inspect subagent model and usage (`/hub`, `/subagents`) | The agent rail and drawer show model, tokens, cost, tool count, and duration when the host supplies them. |
| ❌ | Configure per-agent models, prewalk, or advisor (`/agents`) | No corresponding Mini App or bot controls. |
| ✅ | List, save, switch, and delete model presets (`/modelpreset`) | `/model_preset` lists presets; `/model_preset <name>` switches an idle managed session. `/settings` selects the forum default. To edit presets, ask the agent. |
| 📱 | Inspect the current model and reasoning level | Read the Mini App header and model/thinking-change markers in the transcript. |
| ❌ | Select model and reasoning level independently (`/model`, `/models`, `/switch`, `/effort`) | No independent selectors. `/model_preset` applies predefined combinations instead. |
| 📱 | Inspect context-use percentage (`/context`) | Read the Mini App header's context gauge. |
| ❌ | Browse detailed context contents (`/context`) | No context inspector. The transcript is not a view of the complete model context. |
| 📱 | View compaction and branch-summary markers | The Mini App transcript displays summaries and changes already made by the host. |
| ❌ | Manually compact or reduce context (`/compact`, `/shake`, `/handoff`) | No controls to initiate these operations. |
| 📱 | Inspect the prompt queue count | The Mini App composer shows the host-reported queued-message count while busy. |
| ❌ | Explicitly queue prompts and edit or remove pending messages (`/queue`, terminal queue controls) | No queue-management controls. Ordinary prompt delivery still follows the host's queue behavior. |
| 📱 | Read todo and background-job tool output | Inspect tool cards in the Mini App transcript. These are emitted results, not the live `/todo` or `/jobs` inspectors. |
| ❌ | Inspect or edit the live todo list (`/todo`) | No dedicated todo inspector or editor. |
| ❌ | Inspect live background jobs or agent-visible tools (`/jobs`, `/tools`) | No dedicated job inspector or tool-catalog viewer. |
| ❌ | Service tiers, extended context, and one-shot model handoff (`/fast`, `/slow`, `/extended-context`, `/prewalk`) | No dedicated controls. |
| ❌ | Planning and goal modes (`/plan`, `/plan-review`, `/vibe`, `/goal`, `/guided-goal`, `/loop`) | No dedicated mode controls. |
| ❌ | Advisor, security scans, and optimization (`/advisor`, `/security`, `/ratchet`) | No dedicated controls. |
| ❌ | Freeze all agents, force tools, or reset approvals (`/pause`, `/force`, `/force:`, `/forget-approvals`) | No equivalent controls. `/stop` only interrupts the current turn. |
| ❌ | Side tasks, maintenance, and debugging (`/btw`, `/tan`, `/seance`, `/omfg`, `/cleanse`, `/debug`, `/memory`) | No dedicated interfaces. |
| ✅ | Select loaded skills for a prompt (`/skill:<name>`) | `/skills` opens the picker; `/skills clear` clears the selection. |
| ❌ | Search, install, or update registry skills (`/skills`, `omp skill`) | The Telegram `/skills` picker selects loaded skills, not registry management operations. |
| ❌ | Toggle the system-prompt skill listing (`/skillful`) | No toggle. |
| ❌ | Run other built-in, file, template, or extension commands (including `/init`) | No OMP command browser or general slash-command dispatch. The Mini App composer sends prompts, not terminal commands. |
| ❌ | Configure OMP or provider authentication (`/settings`, `/setup`, `/providers`, `/login`, `/logout`) | Telegram `/settings` manages forum policy and defaults, not OMP settings or credentials. `/setup` enrolls a forum. |
| ❌ | Manage extensions or MCP (`/extensions`, `/status`, `/marketplace`, `/plugins`, `/plugin`, `/reload-plugins`, `/mcp`) | Telegram `/status` reports service diagnostics, not OMP's extension dashboard. |
| ❌ | Inspect provider limits or open usage dashboards (`/usage`, `/stats`, `/trace`) | No provider-limit, stats, or trace controls. Displayed subagent costs are separate. |
| ✅ | Copy displayed reply text or follow a link | Use Telegram's or the browser's ordinary selection and link actions. |
| ❌ | Use OMP's copy picker or open-last-link command (`/copy`, `/open`) | No equivalent command controls. |
| ❌ | Export, dump requests, or share saved sessions (`/export`, `/dump`, `/share`) | No HTML export, request dump, or encrypted saved-session sharing. |
| 📱 | Change interface themes (`/settings`) | Cycle the Mini App's system, light, and dark appearance in its header. This is independent of OMP's terminal theme. |
| ❌ | Git, editor, and SSH interfaces (`/git`, `/local`, `/ssh`) | No remote Git UI, local editor, or SSH-host manager. |
| ❌ | Browser and desktop modes (`/browser`, `/computer`) | No host browser or desktop-mode toggles. |
| ❌ | Voice and recording (`/live`, `/record`) | No realtime voice or terminal-recording controls. |
| ❌ | Changelog and shortcuts (`/changelog`, `/hotkeys`) | No corresponding OMP viewers. |
| ❌ | List or clear worktrees (`omp worktree`) | No CLI list or clear interface. |
| ❌ | Browse the complete model catalog or manage agent definitions (`omp models`, `omp agents`) | Telegram preset listing and Mini App live-subagent controls do not expose these CLI interfaces. |
| ❌ | CLI protocols, credentials, and onboarding (`omp acp`, `omp auth`, `omp auth-broker`, `omp auth-gateway`, `omp login`, `omp token`, `omp setup`) | Run locally. Telegram `/setup` is unrelated to OMP onboarding. |
| ❌ | CLI configuration and installation (`omp config`, `omp install`, `omp plugin`, `omp ssh`, `omp tiny-models`, `omp update`, `omp completions`) | Run locally. |
| ❌ | CLI session transfer, storage, and processes (`omp session`, `omp share`, `omp anonymize`, `omp gc`, `omp ps`, `omp shell`) | No equivalent transfer, sharing, storage, process-manager, or shell interfaces. |
| ❌ | CLI coding workflows (`omp git`, `omp commit`, `omp cleanse`, `omp find`, `omp compress`) | No dedicated CLI interfaces. |
| ❌ | CLI inspection and diagnostics (`omp read`, `omp grep`, `omp search`, `omp toks`, `omp ttsr`, `omp images`, `omp grievances`) | Run locally. |
| ❌ | CLI benchmarks and previews (`omp bench`, `omp if-bench`, `omp dry-balance`, `omp gallery`, `omp predict`, `omp render`) | Run locally. |
| ❌ | CLI relay, media, and usage (`omp browser-relay`, `omp clip`, `omp play`, `omp say`, `omp stream`, `omp stats`, `omp usage`) | No relay-management, recording, broadcast, speech, or usage-dashboard interfaces. |

## Setup


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

   `pnpm cli setup` explains the Mini App and asks whether to enable it. Telegram-only is the default. You can send prompts and images, read replies, and answer agent questions in Telegram. Enable the Mini App if you also want a live transcript, tool details, and subagent controls.

   If you enable it, enter your public HTTPS address, such as `https://omp.example.com`, at the `Public HTTPS origin` prompt. Set the listen host and port for your reverse proxy or tunnel.

   ```sh
   pnpm cli setup
   pnpm cli bot add
   pnpm cli create /path/to/project
   pnpm start
   ```

   Enter the BotFather token when `bot add` asks. If you enabled the Mini App, keep the default short name, `app`.

   <details>
   <summary>Example CLI commands and output</summary>

   These examples use filler values. Output excerpts omit package-manager headers and unrelated prompts. Never paste a real bot token into documentation.

   ```text
   $ pnpm cli setup
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
   9. Set `Public HTTPS origin` to `https://omp.example.com` in `pnpm cli setup`. Use the complete per-bot URL printed at startup for BotFather, such as `https://omp.example.com/?bot=123456789`.

   The hostname stays the same across bot and tunnel restarts. Keep the bot and the `cloudflared` service running to make the Mini App available.

   See [Cloudflare's tunnel setup guide](https://developers.cloudflare.com/tunnel/get-started/) for platform-specific installation commands.

   </details>

   <details>
   <summary>Option 2: Set up HTTPS manually</summary>

   1. Point your hostname, such as `omp.example.com`, at the server running your reverse proxy.
   2. Configure the proxy to serve that hostname over HTTPS with a publicly trusted certificate.
   3. Forward requests to the bot's configured listen address, which defaults to `http://127.0.0.1:3000`. Use an address reachable from the proxy if it runs on another machine.
   4. Enable WebSocket forwarding for `/api/socket`, preserving the request path and query string.
   5. Set `Public HTTPS origin` to `https://omp.example.com` in `pnpm cli setup`.
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

Interactive chat assignment and request approval ask for both prompt settings. Assigned forums change them through `/settings`; `/setup` completes enrollment and opens that panel. Scripts can pass `--all-messages-are-prompts true|false` and `--users-can-propose-prompts true|false` to `chat add` or `approve`. Repeating `chat add` updates the assignment; omitted flags preserve existing values. Command menus update on configuration reload.

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

`setup` accepts `--public-url`, `--host`, `--port`, `--data-dir`, `--omp-executable`, repeated `--omp-arg`, `--clear-omp-args`, `--max-sessions`, `--startup-timeout-ms`, and `--relay-url`. Use `--relay-url -` to clear the relay. OMP arguments are literal strings, not shell commands.

Defaults are Telegram-only operation, loopback, port 3000, executable `omp`, eight resident managed hosts, and a 60000 ms startup timeout. An empty `publicUrl` selects Telegram-only operation. To enable the Mini App, configure an HTTPS origin without credentials, path, query, or fragment. Each bot then needs a `miniAppShortName` matching its BotFather registration. Reconfigure with `pnpm cli setup` to change modes.

For scripts, use `pnpm cli setup --public-url ''` for Telegram-only operation or `pnpm cli setup --public-url https://omp.example.com` to enable the Mini App; replace the example origin with your own. Enabling supplies `app` as the short name for existing bots that have none; register that name in BotFather. Existing short names are retained when changing modes so registered launch links keep working when re-enabled.

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



