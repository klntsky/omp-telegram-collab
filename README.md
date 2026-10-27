# OMP Telegram Collab

Use your own Telegram bot to expose local OMP coding sessions as forum topics. Telegram messages and the Mini App connect to the same OMP session. The Mini App includes OMP's Collab Web renderer as editable source, not an iframe.

This implementation uses the self-hosted setup flow from the [shared design](https://chatgpt.com/share/6ae0b778-f860-83ed-a675-050ed4c7c1f9). You create the bot and the groups. The service runs local OMP processes and polls Telegram. It does not host a SaaS dashboard or provision remote agent machines.

## Connect your bot

1. Install Node.js 22.13 or newer, pnpm, and [OMP](https://github.com/can1357/oh-my-pi). Configure OMP's model credentials on the service account.
2. Create a bot with BotFather. Keep its token out of Telegram group messages and source control.
3. Install dependencies. If `.env` does not exist, copy the blank template. If it already exists, keep it and add the missing variables.

```sh
pnpm install
cp -n .env.example .env
```

4. Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_USERNAMES`, and `PUBLIC_URL` in `.env`. Use comma-separated Telegram usernames for owners, with or without `@`. Matching is case-insensitive. `PUBLIC_URL` must be the public HTTPS origin, without a path, query, fragment, or embedded credentials.
5. Build and start the service.

```sh
pnpm build
pnpm start
```

`pnpm start` and `pnpm dev` load `.env` from the current working directory. Exported environment variables override values in that file. No JSON configuration file or initialization wizard is used. Relative `DATA_DIR` and `OMP_CWD` values resolve against the current working directory.

6. Serve the application's HTTP port through an HTTPS reverse proxy. Forward WebSocket upgrades for `/api/socket`. Keep the default loopback bind address when the proxy runs on the same host. Long polling needs no Telegram webhook or inbound webhook port.
7. Use BotFather's `/newapp` to create a direct-link Mini App for your bot. Its short name must match `TELEGRAM_MINI_APP_SHORT_NAME`, which defaults to `collab`. Set its web URL to the per-bot URL printed at startup, such as `https://your-host.example/?bot=YOUR_NUMERIC_BOT_ID`. This is the bot's ID, not an owner ID. Telegram requires an HTTPS URL accessible from the user's device.
8. Create a Telegram supergroup and enable Topics. Add your bot as an administrator with **Manage Topics**. The bot's private `/start` response supplies an add-to-group link.
9. From a configured owner account that is also a current group administrator, send `/setup` in the group.

The bot cannot enable Topics or create the group for you. Adding the bot does not automatically enroll a group.

## Configure the environment

`.env.example` lists the supported variables with empty values. The three required single-bot values have no defaults. Blank optional values use these defaults.

| Variable | Default or format |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Required BotFather token. |
| `TELEGRAM_OWNER_USERNAMES` | Required comma-separated owner usernames. |
| `PUBLIC_URL` | Required public HTTPS origin. |
| `TELEGRAM_MINI_APP_SHORT_NAME` | `collab`. |
| `HOST` | `127.0.0.1`. |
| `PORT` | `3000`. |
| `DATA_DIR` | `.omp-telegram`. |
| `OMP_EXECUTABLE` | `omp`. |
| `OMP_CWD` | Current working directory. |
| `OMP_MAX_SESSIONS` | `8`. |
| `OMP_STARTUP_TIMEOUT_MS` | `60000`. |
| `OMP_RELAY_URL` | OMP's configured relay. Remote connections require `wss`; loopback development relays may use `ws`. |
| `OMP_ARG_1`, `OMP_ARG_2`, and later numbers | Optional literal OMP arguments, sorted numerically. Empty arguments are omitted. The service does not split or evaluate shell syntax. |
| `TELEGRAM_BOT_NAMES` | Unset for one bot. A comma-separated list enables named-bot configuration. |

To configure multiple bots, set `TELEGRAM_BOT_NAMES=work,personal`. Supply `TELEGRAM_WORK_BOT_TOKEN` and `TELEGRAM_WORK_OWNER_USERNAMES`, then the corresponding `TELEGRAM_PERSONAL_*` variables. Each bot can also set its own `TELEGRAM_WORK_MINI_APP_SHORT_NAME` or `TELEGRAM_PERSONAL_MINI_APP_SHORT_NAME`. Named bots do not inherit the single-bot token or owner list. Their BotFather web URLs must contain their own bot IDs. The HTTP server and OMP runtime settings remain shared.

Configure an argument containing spaces as one quoted `.env` value, such as `OMP_ARG_2="model with spaces"`. Numbered arguments replace a JSON array or shell command string.

## Work in topics

- Send `/new Implement authentication` in an enrolled group to create a topic and start its OMP session.
- Create a topic with Telegram's normal controls to initialize a session without an initial prompt. General does not become a session.
- In a session topic, mention your bot or reply to a message from that bot to instruct OMP. Ordinary discussion does not become a prompt.
- Select **Open Session** to open the source-owned Collab Mini App. Group buttons use direct Mini App URL links, not private-chat-only `web_app` buttons.
- Use `/session` to retrieve the current topic's Mini App link. Use `/stop` to interrupt the current agent turn.
- Rename a topic to update its stored display name. Close it to archive instructions without deleting OMP history. Reopen it to accept instructions again.
- Use `/status` and `/help` for readiness and command guidance.

To attach a running session, enable control sharing in its OMP terminal with `/collab`. Run `omp collab list --json` on the service machine to obtain the instance ID. As the configured owner and a group administrator, send `/attach INSTANCE_ID` in the group. The bot creates a topic for that existing session. Do not paste a Collab capability link into Telegram. Attached hosts remain owned by their original terminal, so stopping this service does not kill them.

## Keep the runtime private

Every authorized member of an enrolled group can instruct its OMP sessions and use their tools. Enroll only trusted groups. OMP executes with the service account's filesystem and credential access. Run this service under a dedicated account or container with only the repositories and credentials that group members may use. This integration is not a sandbox.

Owner permissions follow the current holder of each configured Telegram username. Usernames can change or transfer. Keep `TELEGRAM_OWNER_USERNAMES` current and choose owners accordingly. Enrollment and attachment check the caller's current group membership, administrator status, and username. Ordinary group-member access still uses Telegram's authenticated numeric identity internally.

Bot tokens stay in environment variables. The data directory contains topic mappings and OMP histories. Keep it private and back it up. Managed sessions have separate history directories. A service restart must not require new Telegram topics.

Managed sessions pin their OMP session ID and exact `history.jsonl` path in `binding.json`. The runtime creates an empty OMP version 3 history header on first launch and resumes that exact file thereafter. Unknown history formats or changed identities fail closed. A process-lifetime SQLite lock prevents two service instances from managing the same data directory.

Mini App links contain opaque mapping IDs, not OMP keys. The backend verifies Telegram's signed `initData`, its age, its signed session parameter, and current group membership. The WebSocket gateway enforces authorization separately from the page. It keeps the OMP room key and write token on the server. A forwarded Mini App link does not grant membership.

The runtime owner can independently create and share OMP Collab links. Those links remain capabilities outside this gateway. Telegram authorization cannot revoke a separately shared upstream link. Do not distribute those links if Telegram membership is your intended access boundary.

Closing a topic preserves history. Telegram does not document a topic-deleted service update, so deleting a topic is not a reliable session-deletion signal. The bot does not delete OMP history on topic closure or service shutdown.

OMP's Collab protocol has no prompt admission acknowledgement or idempotency key. The bot marks an initial task submitted before sending it and retries only an explicit startup rejection. A crash between that mark and the send can require you to resend the task. A disconnect does not cause automatic replay of a possibly executed instruction.

After an unexpected Collab disconnect, Telegram mirroring retries the subscription up to five times with backoff. Recovery delivers unseen assistant entries from the retained transcript. It does not resubmit prompts. If recovery fails, the bot posts a notice and a later mention can reconnect. Telegram polling retries network failures, rate limits, and server errors; invalid credentials and polling conflicts stop the service.

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

The verification scripts use local fixtures where Telegram credentials are unavailable. A real Telegram acceptance check requires your BotFather token, configured Mini App, HTTPS deployment, and a forum group. Check enrollment, `/new`, a mentioned prompt, the Open Session button, topic close and reopen, and denial after a member leaves the group. Do not treat an offline fixture as proof that BotFather or Telegram client setup is correct.

Local verification passed TypeScript checking, the production build, the regression suite, and the repeatable smoke command. The smoke verifies actual Node `.env` loading and environment precedence, launches actual OMP without a model request, and uses a local Telegram API fixture for bot and authorization behavior. Earlier Chromium checks exercised the built Mini App with Telegram's official SDK, including fresh-auth rejoin, unauthenticated denial, and archived read-only mode.
