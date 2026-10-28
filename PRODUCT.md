# Product

This document defines current user-visible behavior. See [Development](DEVELOPMENT.md) for setup and operations.

## 1. Telegram sessions


### 1.1. Sessions and commands

| Command or action | Result |
| --- | --- |
| `/new <task>` | Create a topic and submit its first task. Bare `/new` asks for the task. |
| Create a topic manually | Register a session. OMP starts on the first instruction or Mini App visit. |
| `/p <prompt>` | Submit a prompt in explicit-command mode. In General, create a topic like `/new`. |
| `/session` | Get the current topic's Mini App link. |
| `/stop` | Interrupt the current agent turn without terminating OMP. |
| `/kill` | Force-terminate the topic's OMP process, even while busy. In-flight work may be lost. |
| `/detach` | Make the topic permanently conversation-only. Requires a project admin. |
| `/attach INSTANCE_ID` | Connect a running OMP host to a new topic. Requires a project admin. |
| `/list_model_presets` | List project presets and the current selection. Requires a project admin. |
| `/model_preset <name>` | Set the forum default in General, or switch an idle topic's session. Requires a project admin. |
| `/setup` | Request enrollment or change an assigned forum's prompt settings. |
| `/status`, `/help` | Show readiness and command help. |

General never becomes a session. `/stop` and `/kill` work only in session topics and require current group membership. Neither starts an idle host. Both cancel pending initial tasks, startup retries, and capacity confirmations.

New session topics get a pinned Open Session message before OMP starts. The bot returns a topic link when `/new` or `/attach` creates a topic. For `/new`, it also forwards the original task below the pin without submitting it twice.

Rename a topic to change its stored display name. Close it to archive instructions; reopen it to resume. Closing or deleting a topic does not delete OMP history. Telegram has no documented topic-deleted service update, so deletion is not a reliable cleanup signal.

`/kill` preserves history and invalidates existing Mini App connections, including automatic reconnects. A later instruction, Rejoin, or fresh Open Session visit can resume a managed session. `/detach` instead disables prompts, reactions, mirroring, approvals, and Mini App access permanently for that topic. It preserves history and does not kill the host. Use `/new` for another session.

### 1.2. Prompts and permissions

Each bot/chat assignment has two settings.

| Setting | Default | Effect |
| --- | --- | --- |
| `all_messages_are_prompts` | `true` | Session-topic text becomes a prompt. When `false`, only `/p <prompt>` submits text. Mentions and replies do not bypass this setting. |
| `users_can_propose_prompts` | `false` | Non-admin prompts are ignored. When `true`, a project admin must approve them. Admin prompts run directly. |

`/p@YourBot <prompt>` also works in explicit-command mode. Other commands, forwarded messages, and bot messages are not prompts. Non-admin `/new` requests follow the proposal setting too.

Proposals show the submitted text for review and execute once after approval. They expire after ten minutes or a service restart. A changed assignment or prompt mode, archived topic, killed session, or departed proposer invalidates approval.

Project admins are the Telegram usernames configured for the directory. They must also be current group members. Telegram group-administrator status alone does not grant project-admin permissions. Only enrollment of an unassigned group requires a Telegram group administrator.

Ordinary group members retain Mini App access, `/stop`, and `/kill`. Prompt restrictions are not access restrictions for the Mini App. See [Projects and access](#2-projects-and-access) before inviting members.

### 1.3. Replies, questions, and activity

The bot mirrors agent replies into the topic. It renders supported Markdown, shows model-provided HTML literally, and leaves unsafe or relative links unlinked. Tables and images become text. Long replies split without breaking formatting or Unicode and retain their reply target.

Mini App prompts also appear in the topic with the sender's Telegram username, or their display name and numeric ID if they have no username.

Agent questions include the full text and numbered option buttons. Choose Other to enter a custom multiline answer through Telegram's reply prompt. The answer goes to the question, not the prompt queue. Cancel dismisses it. Answers from the Mini App or terminal close the Telegram controls too. Current group members can answer; OMP resolves competing responses.

| Indicator | Meaning |
| --- | --- |
| 👀 reaction | The bot received eligible input. |
| 🤝 reaction | OMP confirmed receipt. For `/stop`, interruption was confirmed. For `/kill`, the process exited. |
| ⚡ topic icon | An agent turn is running, including tool work. |
| ✅ topic icon | OMP is alive and idle. |
| 🏁 topic icon | OMP is stopped or has not started. |

Approval alone does not produce a receipt reaction. Failed or rejected instructions do not get one. A relay disconnect does not mean OMP stopped. The bot checks liveness every 30 seconds and preserves confirmed icons across restarts. Reactions and icon changes depend on Telegram permissions and rate limits.

Telegram delivery uses a per-chat queue with at least 3.1 seconds between scheduled operations. Questions and receipts take priority over icon updates. A Telegram `429` pauses delivery for `retry_after`. Ambiguous network failures are not retried automatically.

### 1.4. Model presets

In General, `/model_preset <name>` saves the default for that bot/chat assignment. New managed hosts apply its models and thinking settings before accepting work, including when resuming history. It overrides restored settings and model-selection flags. Existing hosts do not change. A missing saved preset fails startup rather than selecting another one.

In a session topic, the command starts the host if needed and switches only that idle session. It does not change the forum default. Attached hosts must use `/modelpreset` in their local terminal. Older managed hosts that cannot switch without changing shared settings must be restarted first.


## 2. Projects and access

A project is identified by its canonical directory. Several chats can share a project. Each topic keeps separate history, but all sessions in that project share working files. Removing a chat disables access and mirroring without deleting history or killing hosts. A chat with saved topics cannot move to another project.


OMP runs with the service account's filesystem and credential access. Project registrations and admin lists do not isolate processes. Use a dedicated account or container if users must not access other checkouts or writable configuration.

Every authorized group member can control sessions through the Mini App, regardless of Telegram prompt settings. Admin permissions follow the current owner of each configured username, which can change or transfer.

The backend checks Telegram's signed Mini App data, its age, its session parameter, and current group membership. WebSocket access has separate checks. Links contain opaque mapping IDs; OMP room keys and write tokens stay on the server. Forwarding a Mini App link does not grant membership. Outbound batches require a fresh membership check, and later frames cannot reuse a pending batch's check.

A kill advances a persistent session generation before notification or termination. Ticket refreshes, socket upgrades, host admission, and mirroring reject the old generation. Automatic reconnect cannot revive a killed session. Explicit Rejoin gets the current generation.

Separately shared OMP Collab links bypass this Telegram gateway. Telegram membership changes cannot revoke those capabilities. Do not distribute them if membership is your intended access boundary.

Keep the YAML and runtime data private. They contain bot tokens, topic mappings, and OMP histories. Service shutdown does not delete history.


## 3. Capacity and reconnection

`maxSessions` limits resident managed OMP processes across all bots and projects, not saved conversations. Empty topics consume no process. Hosts idle for five minutes may retire; the runtime tries least-recently-used idle hosts sooner when it needs capacity. Connected Mini Apps and pending or active work protect a host.

Retirement waits for OMP's guarded shutdown and never escalates to signals. This path was verified with OMP 18.13.1. Older hosts without that support are not forcibly retired. `/kill` is separate: it verifies process identity before SIGKILL and waits for exit.

If retirement cannot free capacity, a project admin can approve a prompt to double the shared limit. Approval saves the new limit and retries the pending initial task once. Other prompts must be resent. Protected configuration requires an administrator CLI update instead. Expired or replayed confirmations cannot increase capacity.

OMP's Collab protocol has no prompt admission acknowledgement or idempotency key. The bot marks an initial task submitted before sending it and retries only explicit startup rejection. A crash between those steps may require resending the task. Disconnects never replay possibly executed instructions.

Telegram mirroring retries an unexpected Collab disconnect up to five times with backoff. Recovery delivers unseen assistant entries, not prompts. If it fails, the bot posts a notice; a later authorized prompt can reconnect. Telegram polling retries network failures, rate limits, and server errors. Invalid credentials and polling conflicts stop the service.

The Mini App retains its transcript and draft during transient failures. Reconnects use capped exponential backoff and a fresh single-use ticket with renewed authentication and membership checks. They do not queue or replay instructions. Leave, denied membership, expired launch credentials, invalid actions, or full capacity stop automatic reconnect. Use Rejoin after capacity becomes available. Reopen Open Session when Telegram credentials expire.

## 4. Attached sessions and transcript

Project admins can attach a control-shared OMP host whose working directory matches the assigned project. Attached hosts survive service shutdown. Killing one requires restarting it locally and attaching the replacement.

The Mini App collapses IRC traffic, system notices, reminders, task-result envelopes, and displayed custom notices. Disclosures reveal their contents. Ordinary prose, attachments, code examples, unknown tags, and incomplete envelopes stay visible. Hidden custom entries remain hidden.
