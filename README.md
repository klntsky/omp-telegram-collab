# OMP Telegram Collab

Use your own Telegram bot to expose local OMP coding sessions as forum topics. Telegram messages and the Mini App connect to the same OMP session. The Mini App includes OMP's Collab Web renderer as editable source, not an iframe.

This implementation uses the self-hosted setup flow from the [shared design](https://chatgpt.com/share/6ae0b778-f860-83ed-a675-050ed4c7c1f9). You create the bot and the groups. The service runs local OMP processes and polls Telegram. It does not host a SaaS dashboard or provision remote agent machines.

## Connect your bot

1. Install Node.js 22.13 or newer, pnpm, and [OMP](https://github.com/can1357/oh-my-pi). Configure OMP's model credentials on the service account.
2. Create a bot with BotFather. Keep its token out of Telegram group messages and source control.
3. Build, then configure through the CLI:

```sh
pnpm install
pnpm build
pnpm cli configure
pnpm cli bot add
pnpm cli create /srv/projects/backend --admin alice --admin bob
pnpm start
```

`configure` prompts for service settings. `bot add` verifies the token with Telegram, hides interactive token entry, and asks for the Mini App short name (`app` by default). `create` registers an existing directory; it does not create or clone a repository. Alternatively, `pnpm cli setup` opens a task-oriented wizard for service, bot, instance, chat, and admin management.

4. Serve the HTTP port through an HTTPS reverse proxy. Forward WebSocket upgrades for `/api/socket`. Keep the loopback bind address when the proxy runs on the same host. Long polling needs no Telegram webhook.
5. Use BotFather's `/newapp` to create a direct-link Mini App. Its short name must match the value configured with `bot add`. Set its web URL to the per-bot URL printed at startup, such as `https://your-host.example/?bot=YOUR_NUMERIC_BOT_ID`.
6. Create a Telegram supergroup, enable Topics, and grant the bot **Manage Topics** and **Pin Messages**.
7. As a current group administrator, send `/setup` in the group. For an unassigned group, the bot supplies a command such as:

```sh
omp-telegram --config /home/operator/.config/omp-telegram/config.yaml approve REQUEST_CODE
```

Run that command on the service machine. It verifies the current group and requester identities, lets you choose or register a directory and both prompt settings, and asks before connecting the group and adding the requester to that directory's admin list. From this checkout, use `pnpm cli` in place of `omp-telegram`. The build also provides the executable `./dist/cli.js`.

The bot cannot enable Topics or create the group. Adding it does not automatically assign a directory. Requests expire after ten minutes and are consumed only after successful configuration persistence.

## Configure instances and chats

An instance's **canonical absolute directory path is its identity**. There are no separate instance names, aliases, or IDs. Relative paths and `.` are accepted by the CLI; symlinks resolve to the same canonical directory. Each instance has a YAML list of admin usernames and any number of bot/chat assignments.

```sh
pnpm cli list
pnpm cli show /srv/projects/backend
pnpm cli admin add /srv/projects/backend carol
pnpm cli admin remove /srv/projects/backend bob
pnpm cli chat add /srv/projects/backend --chat -1001111111111
pnpm cli chat add /srv/projects/backend --chat -1002222222222 --all-messages-are-prompts false --users-can-propose-prompts true
pnpm cli chat list /srv/projects/backend
pnpm cli chat remove /srv/projects/backend --chat -1001111111111
```

Chat assignment validates the group's Topics setting and the bot's administrator permissions before enrollment. A bot/chat pair belongs to exactly one path. Multiple chats can share a directory, and each topic retains its own conversation and history. Those conversations intentionally share working files.

Each bot/chat assignment has two Telegram prompt settings:

| Setting | Default | Behavior |
| --- | --- | --- |
| `all_messages_are_prompts` | `true` | Treat session-topic text as prompts without requiring a mention. When `false`, require `/p <prompt>` in session topics and ignore ordinary messages, including mentions and replies. `/p` in General always works like `/new`. |
| `users_can_propose_prompts` | `false` | Ignore non-admin prompts. When `true`, non-admin prompts wait for an instance admin to press **Approve prompt**; instance admins' own prompts run directly. |

Guided `setup`, interactive `chat add`, and request approval ask for both settings. Assigned forums also offer both choices through `/setup` buttons. For automation, `chat add` and `approve` accept `--all-messages-are-prompts true|false` and `--users-can-propose-prompts true|false`. Re-running `chat add` updates an existing assignment; omitted flags preserve its current values. Changes and chat-scoped command menus apply on configuration reload without restarting bots.

Use `pnpm cli bot add` repeatedly to run multiple bots simultaneously. `bot list` shows numeric bot IDs without tokens. With multiple configured bots, supply `--bot ID` on chat commands in scripts; interactive commands can prompt. One bot can serve multiple paths, and one path can have chats served by multiple bots.

For noninteractive bot registration, use `bot add --token-stdin` or `bot add --token-env VARIABLE`, optionally with `--mini-app-short-name NAME`. The latter imports the token into the protected configuration; it is not a permanent environment reference. For noninteractive request approval:

```sh
pnpm cli approve REQUEST_CODE --path /srv/projects/backend --yes
```

CLI configuration is authoritative. Configured instance admins who are current group members may enroll assigned groups with `/setup`, change prompt settings, attach hosts, approve user proposals, and approve capacity increases; Telegram group-administrator status is not required. Ordinary current members retain session access, `/stop`, and `/kill`; Telegram prompting and `/new` follow the proposal setting. Local CLI access is the bootstrap authority for configuration. Unassigned forums still require a current group administrator to request setup.

Removing a chat disables its gateway access and mirroring without deleting histories or force-killing hosts. It can reconnect to the same path. Reassigning a chat with saved topics to another path is rejected. Remove all chat assignments before `remove PATH`; registration removal never deletes the directory or histories. A moved directory has a different identity; old sessions are not silently retargeted. A missing or retargeted directory makes its instance unavailable.

## Configuration files and permissions

The CLI manages YAML at `$XDG_CONFIG_HOME/omp-telegram/config.yaml`, defaulting to `~/.config/omp-telegram/config.yaml`. No manual editing is required. Every command accepts a global `--config PATH`, before or after the command:

```sh
pnpm cli --config /etc/omp-telegram/config.yaml setup
pnpm cli --config /etc/omp-telegram/config.yaml start
pnpm cli show /srv/projects/backend --config /etc/omp-telegram/config.yaml
```

Configuration includes bot tokens, path-keyed instances, admin lists, chat assignments, and service settings. Files are created privately. Updates validate and atomically replace the selected file, preserving existing ownership and mode. Read/start operations never substitute an empty configuration for an unreadable or invalid file.

There is no read-only flag: both the configuration file and its parent directory must be writable for CLI or bot configuration mutations. A readable protected configuration still runs sessions normally. An administrator can use the same CLI under an account allowed to update it. Protect both the file and its parent directory from the service user to prevent replacement.

SQLite, pending requests, process records, and histories live in a separate writable `dataDir` (new configurations default to a `data` directory beside the YAML). They cannot override configured directory/chat/admin associations. Back up both configuration and runtime data.

Changes notify the selected running service over a local control socket and await acknowledgement. The service also watches the configuration for administrator updates. Instance/admin/chat/limit changes apply without restarting bots; bot, listener, and other runtime-setting changes restart the service's runtime components. Active guarded hosts and history files are preserved, but connected Mini Apps may need to rejoin. A rejected reload reports that configuration was saved but not applied. `pnpm cli reload` requests another application attempt. Changing `dataDir` selects a different state directory; it does not migrate histories.

For scripts, `configure` accepts `--public-url`, `--host`, `--port`, `--data-dir`, `--omp-executable`, repeated `--omp-arg`, `--clear-omp-args`, `--max-sessions`, `--startup-timeout-ms`, and `--relay-url` (`-` clears the relay). OMP arguments are literal strings, never shell-evaluated. Defaults are loopback, port 3000, executable `omp`, eight resident managed hosts, and a 60000 ms startup deadline. The public URL must be an HTTPS origin without credentials, path, query, or fragment.

## Migrate an existing deployment

Stop the old service through its normal supervisor before starting the upgraded service. Keep its `.env`, data directory, and histories in place. From the same launch directory, run:

```sh
pnpm cli migrate
pnpm cli list
pnpm start
```

Use `--config PATH` on all three commands when selecting a nondefault configuration. Migration reads `.env` with exported environment values taking precedence, imports single-bot or named-bot credentials/settings, and registers the canonical legacy `OMP_CWD`. The old bot owner lists merge into that path's admin list. Existing configured bots' chat assignments are imported from SQLite.

Migration never overwrites an existing YAML file or rewrites histories, bindings, session IDs, pending tasks, reply targets, or generation counters. Startup backfills only missing session paths after checking saved history/binding identities. Conflicting active-session paths or unknown history formats fail rather than silently starting new conversations. Historical data for unconfigured bots remains untouched and unavailable until those bots are restored.

For legacy pnpm deployments only, starting with no default YAML and existing bot environment variables also performs this import automatically. Explicitly selecting a missing file with `--config` never falls back to environment configuration; run `migrate` or `configure` first. After migration, YAML is authoritative and environment settings no longer override it. `.env.example` is retained only as a legacy-import reference.

## Run under PM2

Build and configure first, then use one PM2-managed service instead of another simultaneous `pnpm start`:

```sh
pm2 start "$(command -v node)" --name omp-telegram-collab --cwd "$PWD" \
  --interpreter none --no-treekill --kill-timeout 75000 --restart-delay 2000 -- \
  "$PWD/dist/cli.js" --config /etc/omp-telegram/config.yaml start
pm2 save
```

Do not export bot tokens into the PM2 launch environment. `pm2 save` records the process entry for resurrection; if PM2 startup is not enabled, run `pm2 startup` and follow its administrator command. Use `pm2 logs omp-telegram-collab` for status. Do not restart unrelated PM2 applications.

`--no-treekill` is required: managed OMP hosts have independent detached PTY supervisors and must not receive PM2's recursive stop/restart signals. Without it, a deployment restart can abort an accepted prompt with `Request was aborted`, including a newly created topic's first task. For an existing entry, use `pm2 restart omp-telegram-collab --no-treekill`, then `pm2 save`; this updates the setting before stopping the old service.

On successful starts, each bot posts **OMP bot service is back online.** in General for its configured, enrolled groups. On orderly shutdown (`SIGINT` or `SIGTERM`), it posts a winding-down notice. Failed startup sends neither notice. Delivery is best effort with a five-second timeout per group; forced termination or a crash cannot send a winding-down notice.


## Work in topics

- Select `/new` from Telegram's group slash-command menu, then reply with the initial task to create a topic and start its OMP session. Alternatively, send `/new Implement authentication` to create it directly. The service registers the command for each configured bot at startup; restart the service after upgrading to publish it.
- When `/new`, its interactive task reply, or `/attach` creates a topic, the bot replies to the triggering message with a direct Telegram topic link in the originating conversation, before host startup.
- Create a topic with Telegram's normal controls to register a session without an initial prompt. Its host starts on the first instruction or Mini App visit, not just because the topic exists. General does not become a session.
- Session-topic input follows the bot/chat prompt settings above. `/p@YourBot <prompt>` is also accepted in explicit-command mode. In General, `/p <task>` creates a new topic like `/new <task>` in either mode; bare `/p` asks for the initial task. General never becomes a session. Other commands, forwarded messages, and bot messages are not submitted as prompts.
- Proposed prompts are copied literally into bot-authored messages for review. Approval executes the stored text once and retains the proposer's message as the reply target. Proposals expire after ten minutes or a service restart. Disabled proposals, changed input mode/assignment, archived topics, killed session generations, and departed proposers cannot be approved. `/new task` and interactive initial tasks from non-admins also require approval before creating a session.
- The bot reacts with **👀** when it receives eligible human text in an enrolled, assigned group, before processing it or waiting for host startup. Ignored discussion and disabled non-admin prompts receive no reaction. Submitted instructions receive **🤝** only when the host confirms receipt in the live Collab transcript; an approval click alone is not an admission receipt. Custom answers use the matching host `ui-request-end` completion; `/stop` uses the matching Collab interruption notice for this bot's connection. A `/stop` with no running host remains 👀 and reports that no session is running. For `/kill`, 🤝 means verified process termination, not prompt admission. Failed, denied, or rejected instructions never get 🤝; foreign prompts and replayed history cannot trigger it. Reaction delivery is best effort and respects Telegram rate limits and the group's allowed reactions.
- Select **Open Session** to open the source-owned Collab Mini App. Group buttons use direct Mini App URL links, not private-chat-only `web_app` buttons.
- Mini App prompts are relayed into the matching Telegram topic as `@username posted a prompt: …`, using Telegram's authenticated username. Accounts without a username use their display name and numeric user ID instead. Prompt text is sent literally and long prompts are split without breaking Unicode.
- Agent questions appear directly in the session topic: full question text, numbered options, descriptions, and help text are sent as literal messages, with long bodies split without breaking Unicode. Options use number emojis in both the text and buttons, with up to five number buttons per row and Cancel on a separate row. Choosing an option replaces the controls with a persistent receipt containing its number and full label; long receipts split without losing text. Checkbox-style questions show the host's current checked choices. Current group members can answer, and the host resolves competing answers.
- For **Other (type your own)**, choose its numbered button first. When OMP requests custom input, the bot opens a native Telegram reply prompt. Type a multiline answer and send it; no mention or command is needed. Text is submitted verbatim to the question, not queued as a new agent instruction. Suggested text is shown above the prompt, not inserted into Telegram's draft. A separate **Cancel** button dismisses the request. Answers submitted in the Mini App or local terminal close the matching Telegram buttons too.
- Every new session topic immediately receives a pinned **Open Session** message before the local host starts, including topics created with `/new` or `/attach`. The inline button belongs to the pinned message; the [Telegram Bot API](https://core.telegram.org/bots/api#pinchatmessage) has no separate button field for the compact pin banner, whose appearance is controlled by the Telegram client.
- For both `/new task` and the interactive `/new` reply, the initial task is copied immediately after that entry and before host startup, using the same `@username posted a prompt: …` style as Mini App prompts (including the display-name/user-ID fallback). This is a visible copy, not a second submission to OMP.
- Topic icons show session activity: **⚡ running**, **✅ completed/idle with the process still alive**, and **🏁 stopped or not yet started**. Live Collab state includes work started in the Mini App or local terminal. A relay disconnect alone does not mean the process stopped, and a guarded shutdown keeps its live status until the host actually exits. Liveness is also checked every 30 seconds while the service is running. The last confirmed icon is saved in SQLite, so unchanged icons are not rewritten after restart. Observed human icon changes update that saved state. Icon changes are best effort and leave the topic name unchanged; Telegram must still grant Manage Topics. The bot deletes its own icon-change service notices, but preserves human edits and rename notices. The icons come from Telegram's [allowed topic icon stickers](https://core.telegram.org/bots/api#getforumtopiciconstickers).
- Agent replies, questions, answer receipts, reactions, and topic-icon writes share a per-chat delivery queue with at least 3.1 seconds between scheduled operations. Questions and receipts take priority over pending icon updates. An explicit Telegram `429` response pauses that chat for `retry_after` and retains still-active work; a host-ended question is not retried into stale buttons. Ambiguous network failures are not retried automatically.
- Use `/session` to retrieve the current topic's Mini App link. In a session topic, `/stop` interrupts the current agent turn without terminating its process; `/kill` force-terminates the session's host process with SIGKILL, even while busy. Both require current group membership and cannot target sessions from General or private chats. Neither command starts an idle host; both cancel pending initial tasks, startup retries, and capacity confirmations for that topic.
- Configured instance admins who are current group members can use `/detach` inside a session topic to make it permanently conversation-only. It removes the custom activity icon, leaving Telegram's default topic icon, and disables prompts, reactions, mirroring, pending approvals, and existing or fresh Mini App joins. Queued activity-icon work settles before the conversation icon is applied; status checks, topic close/reopen events, configuration reloads, and service restarts cannot restore an activity icon. Later manual icon choices are left alone. Detaching preserves history and does not kill the host. Use `/new` for a separate session topic; `/detach` is registered in both group-wide and chat-specific command menus.
- Configured instance admins who are current group members can use `/list_model_presets` and `/model_preset <name>` in General or an open managed-session topic. Both refuse conversation-only topics; Telegram group-administrator status alone does not grant access.
  - In **General**, listing reads the assigned project's OMP presets without starting a host and shows the forum default. `/model_preset <name>` validates and saves `default_model_preset` in that bot/chat assignment's YAML configuration. Other forums and bots retain their own defaults.
  - Each newly started managed host applies the current forum default's role models and thinking settings before accepting instructions or Mini App joins, including when resuming saved history. The default takes precedence over restored model/thinking and configured model-selection flags. Changing it leaves already-running hosts unchanged. With no default configured, normal OMP startup selection applies. A missing or unavailable saved preset fails startup rather than silently choosing another preset.
  - In a **work topic**, listing and switching use its host, starting it on demand without a model prompt. Switching requires an idle host and changes only that OMP session, without saving a per-topic bot setting or changing the forum default. A later host launch uses the then-current forum default.
  Create presets locally with OMP's `/modelpreset save <name>`. Attached hosts do not expose this control; use `/modelpreset` in their local terminal. Older managed hosts' preset controls are refused because they persist shared OMP settings; retire and restart those hosts to load session-only control. `/kill` followed by Open Session does this forcefully while preserving history. Both commands are registered in the group and chat-specific slash-command menus, including `/p` mode; menu visibility does not grant administrator access.
- `/kill` preserves saved history and the topic's open/closed status, sets the **🏁 stopped** icon before acknowledging the command, and invalidates existing Mini App joins with a persisted per-session generation counter. Automatic reconnect retains its original counter; stale ticket refreshes receive terminal HTTP 409, and stale WebSocket tickets cannot start a host even if the close frame was lost. An open managed session can resume the same history on a later explicit instruction, **Rejoin**, or fresh Open Session visit. Forceful termination can lose in-flight work.
- Rename a topic to update its stored display name. Close it to archive instructions without deleting OMP history. Reopen it to accept instructions again.
- Use `/status` and `/help` for readiness and command guidance.

Agent replies render Markdown in Telegram: headings, bold, italic, strikethrough, links, lists, quotes, and inline/fenced code. The service reuses the vendored OMP Markdown lexer and sends only Telegram-supported HTML formatting; model-provided HTML is shown literally, and unsafe or relative links are not made clickable. Tables and images are represented as readable text. Long replies split at decoded-text limits without breaking formatting, HTML escapes, or Unicode code points. Every chunk retains its triggering Telegram reply target.

The Mini App transcript collapses IRC traffic, system notices and reminders, task-result envelopes, and displayed custom notices by default. Select a disclosure to inspect its contents. Ordinary prose, attachments, Markdown code examples, unknown tags, and incomplete envelopes stay visible; hidden custom entries remain hidden.

To attach a running session, enable control sharing in its OMP terminal with `/collab`. Run `omp collab list --json` on the service machine to obtain the OMP host instance ID (distinct from this service's path-identified instances). As a configured instance admin who is a current group member, send `/attach INSTANCE_ID` in the group. The host's working directory must match the assigned path. Do not paste a Collab capability link into Telegram. Attached hosts remain owned by their original terminal, so stopping this service does not kill them. An explicit `/kill` in their session topic does terminate the attached process; restart it in its original terminal and attach the new host to use it again.

## Keep the runtime private

Telegram prompt settings control message submission, not OS isolation or Mini App authorization. Every authorized member retains Mini App access and can control sessions through it. Instances, chat assignments, and admin lists are organizational conventions, not a security boundary. OMP executes with the service account's filesystem and credential access; a script can access other checkouts and writable configuration under that user. Use a dedicated account or container when OS-level isolation is needed.

Instance admin permissions follow the current holder of each configured Telegram username. Usernames can change or transfer. Enrollment, attachment, prompt submission/approval, and capacity approval check the caller's current group membership and configured username, not Telegram group-administrator status. Ordinary group-member access still uses Telegram's authenticated numeric identity internally.

Bot tokens are stored in the selected YAML configuration. Keep it private and out of source control. The data directory contains topic mappings and OMP histories. Managed sessions have separate history directories, and restarting the service does not require new Telegram topics.

Managed sessions pin their OMP session ID and exact `history.jsonl` path in `binding.json`. The runtime creates an empty OMP version 3 history header on first launch and resumes that exact file thereafter. Unknown history formats or changed identities fail closed. A process-lifetime SQLite lock prevents two service instances from managing the same data directory. New managed hosts use independent PTY supervisors, so service shutdown can leave working hosts alive and the next service can rediscover them.

Mini App links contain opaque mapping IDs, not OMP keys. The backend verifies Telegram's signed `initData`, its age, its signed session parameter, and current group membership. The WebSocket gateway enforces authorization separately from the page. It keeps the OMP room key and write token on the server. A forwarded Mini App link does not grant membership.

Outbound frames are sent in bounded batches. Each batch is frozen before a fresh membership check; frames received while that check is pending wait for the next check. This preserves ordered live output without one Telegram lookup round trip per token, while preventing later frames from reusing an earlier authorization decision.

The runtime owner can independently create and share OMP Collab links. Those links remain capabilities outside this gateway. Telegram authorization cannot revoke a separately shared upstream link. Do not distribute those links if Telegram membership is your intended access boundary.

Closing a topic preserves history. Telegram does not document a topic-deleted service update, so deleting a topic is not a reliable session-deletion signal. The bot does not delete OMP history on topic closure or service shutdown.

The configured `maxSessions` bounds resident managed OMP hosts across all bots and instances, not saved conversations. Empty topics do not consume a process. The runtime checks for unused hosts idle for five minutes and tries least-recently-used idle hosts sooner when capacity is needed. Connected Mini Apps and pending/active instructions protect their hosts. Retirement uses OMP's guarded interactive shutdown: admitted submissions, turns, queues, and async work must settle before exit. It never escalates to termination signals. This path is verified with OMP 18.13.1. Older hosts without the lifecycle extension are not forcibly retired.

Explicit `/kill` is separate from guarded retirement: it verifies the pinned session, registry, and live process identity before SIGKILL and waits for process exit. It can terminate a managed host recovered after a service restart without first launching or joining it. Normal idle retirement and topic closure still never escalate to signals.

The generation counter advances before any kill notifications or process termination. Ticket refresh, WebSocket upgrade, host admission, and background mirroring reject stale generations, including after asynchronous membership or liveness checks. The counter survives service restarts. Explicit Rejoin acquires the current generation; it does not re-enable older pages or tickets.

If safe retirement cannot free capacity and the configuration is writable, Telegram posts an expiring **Confirm current → proposed** / **Cancel** request in the affected topic. Only that instance's configured admin who is a current group member can approve it. Approval persists the doubled shared limit in YAML and retries the pending initial task without replaying submitted instructions. With protected configuration, the bot suggests an administrator CLI command instead; it cannot bypass the limit with a runtime-only override. Other prompts must be resent. Stale, forwarded, expired, unauthorized, or replayed confirmations cannot increase capacity. The Mini App stops automatic reconnection after capacity rejection; select **Rejoin** when capacity is available.

OMP's Collab protocol has no prompt admission acknowledgement or idempotency key. The bot marks an initial task submitted before sending it and retries only an explicit startup rejection. A crash between that mark and the send can require you to resend the task. A disconnect does not cause automatic replay of a possibly executed instruction.

After an unexpected Collab disconnect, Telegram mirroring retries the subscription up to five times with backoff. Recovery delivers unseen assistant entries from the retained transcript. It does not resubmit prompts. If recovery fails, the bot posts a notice and a later authorized prompt can reconnect. Telegram polling retries network failures, rate limits, and server errors; invalid credentials and polling conflicts stop the service.

The Mini App keeps its transcript and draft during transient WebSocket failures and reconnects with capped exponential backoff. Every reconnect obtains a fresh single-use gateway ticket and rechecks Telegram authentication and group membership. It does not queue or replay agent instructions. Explicit Leave, denied membership, expired Telegram launch credentials, invalid actions, or a full host capacity stop reconnection; reopen the topic's Open Session button when Telegram authentication expires. Live host broadcasts may precede the welcome snapshot and do not invalidate the session handshake.

## Modify the Mini App

The fork lives in `web/src`. The transcript, tool cards, composer, and agent panels come from OMP Collab Web. `web/upstream.json` records the source revision, and `web/LICENSE.upstream` preserves its license. Authentication and WebSocket transport are local adaptations. Edit these files and run `pnpm build` to deploy your changes.

The backend uses OMP's existing Collab protocol rather than maintaining a separate agent conversation. Normal OMP RPC mode does not start a Collab host. Managed sessions therefore run interactive OMP under a PTY. OMP's registry discovers their rooms, and the backend connects as a guest.

## Verify changes

```sh
pnpm check
pnpm test
pnpm build
pnpm smoke
```

`pnpm check` strictly typechecks application code, the Mini App, all tests, and TypeScript scripts through `tsconfig.verification.json`.

`pnpm smoke` runs four isolated subprocess stages: compiled CLI, Telegram behavior, gateway authorization, and real OMP runtime. Every selected stage runs even if an earlier stage fails. Original subprocess diagnostics remain visible; the final result names each stage and exits nonzero if any failed.

Run a stage independently with `pnpm smoke:cli`, `pnpm smoke:telegram`, `pnpm smoke:gateway`, or `pnpm smoke:runtime`. Select an ordered subset with, for example, `pnpm smoke telegram gateway`. The CLI stage requires a current `pnpm build`; the runtime stage requires the OMP executable and credentials described below. Telegram and gateway stages use disposable local fixtures and need no live Telegram credentials.

The verification scripts use local fixtures rather than live Telegram credentials. A real Telegram acceptance check requires your BotFather token, configured Mini App, HTTPS deployment, and forum groups. Check `/setup` request creation and CLI approval, multiple chats per path, different admins for different paths, `/new`, prompt routing, topic icons, topic close/reopen, and denial after a member leaves or the chat assignment is removed. Do not treat an offline fixture as proof that BotFather or Telegram client setup is correct.

For lifecycle-only regression coverage, run `pnpm exec tsx --test test/lifecycle.test.ts`. The local Telegram fixture checks General payloads (no `message_thread_id`, including no explicit General ID `1`), bot/group isolation, duplicate shutdown, delivery failures, and failed startup. During a real deployment check, verify one online notice in General after startup and one winding-down notice after an orderly stop; never stop a service that owns your active coding session just to run this check.

For focused real-process kill verification, run `pnpm exec tsx scripts/runtime-kill-smoke.ts`. It starts disposable OMP hosts on a local relay and checks busy attached-host termination, recovered managed-host termination, exact-history resumption, identity-mismatch refusal, unrelated-host survival, startup cancellation, and concurrent retirement without a model prompt or live Telegram request.

The smoke command exercises the compiled CLI's legacy migration, alternate configuration paths, per-path administrators, protected-file reads and mutation refusal; launches actual OMP in multiple instance directories; and migrates a legacy database while verifying unchanged real history bytes, topic identity, pending tasks, and recovery of the same live host. It also uses a local Telegram API fixture for bot and gateway behavior. No model request or live Telegram call is made. Browser acceptance should additionally verify automatic reconnect with a fresh ticket, retained transcript/draft, explicit Leave, unauthenticated denial, and archived read-only mode. Real OMP startup requires the executable, configured credentials, and enough resources to start within its deadline.
