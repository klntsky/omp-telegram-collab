# Product

This document defines current user-visible behavior. See [Development](DEVELOPMENT.md) for setup and operations.

## 1. Telegram sessions


### 1.1. Sessions and commands

| Command or action | Result |
| --- | --- |
| `/new <task>` | Create a topic and submit its first task. Bare `/new` asks for the task. |
| Create a topic manually | Register a session. OMP starts on the first instruction or Mini App visit. |
| `/p <prompt>` | Submit a prompt in explicit-command mode. In General, create a topic like `/new`. |
| `/skills` | Pick skills to mention in your next accepted prompt in this topic. `/skills clear` clears your pending selection. |
| `/set_default_new_topic_skill <exact-skill-name>` | Set this forum's default skill for future managed topics. Requires an instance root or bot admin; no argument shows it. |
| `/unset_default_new_topic_skill` | Remove this forum's default skill for future topics. Requires an instance root or bot admin. |
| `/session` | Get the current topic's Mini App link. |
| `/stop` | Interrupt the current agent turn without terminating OMP. |
| `/kill` | Force-terminate the topic's OMP process, even while busy. In-flight work may be lost. |
| `/terminate` | Instance-root or bot-admin service-wide break: persist `terminated: true`, force-kill all session hosts across bots, and keep the bot online. |
| `/detach` | Make the topic permanently conversation-only. Requires an instance root, bot admin, or this topic's admin. |
| `/attach INSTANCE_ID` | Connect a running OMP host to a new topic. Requires an instance root or bot admin. |
| `/list_model_presets` | List project presets and the current selection. Requires an instance root or bot admin, or this topic's admin outside General. |
| `/model_preset <name>` | Set the forum default in General (instance root or bot admin), or switch an idle topic's session (also available to that topic's admins). |
| `/make_admin [@username]` | Promote by username (optional `@`), or reply without arguments. Numeric ID arguments are rejected. General grants bot-wide access; other topics grant topic-only access. |
| `/list_admins` | List this forum's global admins and topic grants. General includes all topics; another topic includes only itself. Available to current group members; accepts no arguments. |
| `/setup` | Request enrollment or change an assigned forum's prompt settings. |
| `/status` | Show forum, host, mirroring, task-admission, recovery, skill-cache and failure diagnostics. Current members can inspect assigned forums, including during service termination. Accepts no arguments. |
| `/help` | Show commands and prompt settings. |

Commands are recognized in message text and at the start of media captions, even without Telegram command entities. Caption commands use the same bot targeting, permissions, prompt settings, and handlers as text commands.

Photos and JPEG, PNG, WebP, or GIF image documents accompany their prompt as image content, not links or filenames. `/new` and `/p` captions submit the image with their instructions. In all-message mode, session-topic images use their caption as the prompt, or “Describe this image.” when no caption is present. Explicit-command mode ignores images without a prompt command unless they reply to this bot. The largest photo size is used; image documents retain their original bytes. Image albums are combined as described in [Prompts and permissions](#12-prompts-and-permissions). Model image support is required.

General never becomes a session. `/stop` and `/kill` work only in session topics and require current group membership. Neither starts an idle host. Both cancel pending initial tasks, startup retries, and capacity confirmations.

New session topics get a quietly pinned OPEN AGENT message before OMP starts. The bot returns a topic link in the originating conversation when `/new` or `/attach` creates a topic, including an interactive task reply. For `/new` or `/p` creating a topic, it forwards any replied-to message below the pin, then the original task message, without submitting the prompt twice. This includes replied-to media without text or captions. Interactive task replies do not forward the bot's task-request message.

The pinned message contains only “Use /p to submit a prompt” in explicit-prompt mode or “Send a message to prompt the agent” in all-messages mode, plus the OPEN AGENT button.

Admin-only button denials appear as callback-query toasts, not chat messages. Command denials remain chat replies.

The service becomes ready after mandatory runtime/history checks, bot identity and cached-command setup, HTTP binding, and the first successful Telegram poll for every configured bot. Session restoration, status maintenance, and fresh skill discovery run afterward without delaying readiness. A slow project's discovery does not delay another project's command-menu refresh.

Online notices are sent after readiness; slow notice delivery does not hold startup open. An orderly shutdown cancels unfinished background refreshes and online notices, drains input acknowledgements, and attempts winding-down notices while teardown proceeds. Restart notices retain the end-to-end downtime measurement; readiness does not imply that every session has already reconnected. Assignment removal disables access immediately and listener cleanup and configuration acknowledgement do not wait for skill discovery.

`/status` is read-only: it does not start hosts, reconnect sessions, retry tasks, or discover skills. General shows forum and project-catalog state without listing other topics. A session topic also shows observed host liveness, mirror connectivity, the latest observed Telegram task's admission state, and scheduled or active recovery. Failed host inspection reports unknown, not stopped; losing mirroring does not imply that the host or task stopped. Unconfirmed admission becomes unknown on disconnection, and an admission receipt is not proof of task completion.

Status retains the latest relevant session and project-catalog failures with operation, observation timestamp, and exact original diagnostics, including multiline messages and available subprocess fields. These observations are scoped to the current bot, assignment and topic and reset on bot restart; historical failures may remain visible after recovery. Skill catalogs persist, but a saved catalog's original discovery timestamp may be unknown. The successful-check timestamp describes this process's catalog check and may use the runtime discovery cache. No additional progress or failure notifications are sent.

Rename a topic to change its stored display name. Close it to archive instructions; reopen it to resume. Closing or deleting a topic does not delete OMP history. Telegram has no documented topic-deleted service update, so deletion is not a reliable cleanup signal.

`/kill` preserves history and invalidates existing Mini App connections, including automatic reconnects. A later instruction, Rejoin, or fresh OPEN AGENT visit can resume a managed session. `/detach` instead disables prompts, reactions, mirroring, approvals, and Mini App access permanently for that topic. It preserves history and does not kill the host. Use `/new` for another session.

While terminated, prompts, callbacks, Mini App agent access, and commands other than read-only `/status` are blocked. Blocked commands receive “The service got terminated, only admin can resume it (remove terminated: true from the config)”. Current human members may still inspect status for an assigned, enrolled forum; status does not resume the service or query suspended hosts. Pending initial tasks and approvals are cancelled; histories remain intact. Only an operator with configuration access can resume service by removing the top-level flag. Restarting the bot does not clear termination.

### 1.2. Prompts and permissions

Each bot/chat assignment has two settings.

| Setting | Default | Effect |
| --- | --- | --- |
| `all_messages_are_prompts` | `true` | Session-topic text and images become prompts. When `false`, use `/p <prompt>` or reply to this bot's messages. Ordinary discussion, mentions, and replies to other users or bots are ignored. |
| `users_can_propose_prompts` | `false` | Prompts without sufficient administrator scope are ignored. When `true`, an authorized admin must approve them. Authorized admin prompts run directly. |

`/p` works in either prompt mode, including `/p@YourBot <prompt>`. Both `/p` and `/new`, including bot-qualified forms, prepend replied-to text or media captions with `> ` on each line, followed by a blank line and any supplied instructions. Bare commands with a text or caption reply submit just the quote. For `/new`, or `/p` in General, the combined text becomes the new session's initial task. Existing authorization and proposal approval still apply. Replies without text or a caption contribute no quote.

Reply quotes never attach the quoted message's photos or image documents to the AI prompt. Only images uploaded in the new prompt message or its album are attached. Forwarding the quoted message into a newly created topic does not submit its media to the AI.

Non-command replies to this bot's own messages behave as `/p` in either mode: they include the same quote and, in General, create a new session and forward both the quoted message and the user's reply below its pin. Authorization and proposal approval remain unchanged. Interactive task-request replies and active or expired agent-question replies retain their dedicated handling; detached topics remain conversation-only.

Telegram's implicit reply to a topic's creation message is topic-routing metadata, not an intentional reply to the bot. Ordinary messages with that metadata remain ignored when `all_messages_are_prompts` is `false`, including topics created by this bot.

Other commands, forwarded messages, and bot messages are not prompts. Non-admin `/new` requests follow the proposal setting too.

Instance roots and bot admins can submit `/new`, `/p` in General, and existing-topic prompts directly. Topic admins can submit `/p` and ordinary prompts directly only within their own topic, and approve proposals for that existing topic. Creating a session through `/new` or General `/p`, or approving a new-topic proposal, requires an instance root or bot admin; topic admins follow the ordinary proposal setting for those requests. Topic admins cannot directly `/attach`, change global/forum settings, approve capacity increases, or `/terminate`.

Proposals send one reply to the original message with “Approve this prompt?” and an approval button, without copying the prompt or sending additional notices. They execute once after approval and expire after ten minutes or a service restart. A changed assignment or prompt mode, archived topic, killed session, or departed proposer invalidates approval.

`/skills` opens a picker bound to the requesting user and source topic, including General. Skill buttons work without Telegram inline mode; when inline mode is enabled, Search opens an inline search for that picker. The inline picker context expires after ten minutes; reopen `/skills` to search again. This does not expire the pending selection.

Bot messages, skill picker confirmations, and new-topic links stay in their intended destination. General messages do not target an ordinary forum thread; session messages remain in their session topic.

Selections accumulate and persist across service restarts, separately for each bot, chat, topic, and user. A confirmation says “Your next message will mention /skill:name.” `/skills clear` removes that user's pending selection in the current topic. Picking a skill does not submit a prompt.

Discovered skills also get `/skill_<alias>` shortcuts for the same canonical skill. Aliases use the lowercase name, replace runs outside ASCII `a-z`, `0-9`, and `_` with `_`, trim edge underscores, and truncate the complete command to 32 characters. The first skill wins an alias collision; no hash suffix is added. Group command menus include at most 100 commands, including built-ins; `/skills` remains available for skills beyond that menu limit.

Startup publishes skill shortcuts optimistically from the last successful per-instance catalog saved across service restarts. Without a saved catalog, groups start with built-in commands. Fresh discovery runs in the background and replaces menus after success, including removing obsolete aliases; slow or failed discovery does not delay polling readiness or discard saved shortcuts. Cached menus do not override live session skill validation.

A bare shortcut queues that skill for the next prompt. A shortcut with task text, such as `/skill_find_skills find a PDF skill`, submits immediately with the canonical skill mention, any pending selections, and the applicable new-topic default, deduplicated. It follows `/p` routing: General creates a new session topic; session topics use their current session in either prompt mode. Reply quotes, supported images and albums, bot-qualified commands, authorization, and proposal approval retain their normal behavior. The shortcut's immediate skill is not queued for a later message if submission is ignored or rejected.

Canonical `/skill:name` references preserve the skill name's exact case and punctuation, including namespaces. Names containing whitespace, control characters, or backslashes are unsupported and reported in the picker. Managed sessions validate against their live loaded skill catalog; older managed hosts without skill-lifecycle support reject selection with an instruction to restart the host. Attached-host discovery uses the assigned instance settings and cannot inspect terminal-private loaded skills. Discovering catalog changes does not automatically reload OMP.

The next accepted prompt starts with the selected `/skill:name` references separated by spaces, followed by a blank line and the normalized prompt, including any existing reply quote. Supported image attachments and quoting behavior are unchanged. These mentions are prompt text; the service does not implement native skill-template expansion.

Image albums are submitted as one prompt with all supported images, their captions in message order, and one pending-skill selection. An album's `/p` or `/new` caption follows the same topic and General routing as a single image. When it creates a topic, the quoted source and every album message are forwarded there.

Pending skills are consumed when the prompt is accepted, or when a non-admin proposal is created. A proposal freezes the composed text for review and later approval; rejecting or expiring it does not restore the selection. Input ignored or rejected before submission retains pending skills, and a known host-starting rejection restores them. Ambiguous delivery errors do not restore selections because the prompt may already have been admitted. For `/new` or `/p` in General, the originating user's General selection accompanies the new topic's initial task and is consumed when that task is durably accepted, or when its proposal is created.

`/set_default_new_topic_skill <exact-skill-name>` updates the per-bot/chat forum default from General or a session topic; it does not change the current session. Only instance roots and bot admins who are current group members can use it. The exact canonical name must exist in the assigned project's skill catalog and contain no whitespace, control characters, or backslashes; case, punctuation, and namespaces are preserved without normalization. No argument displays the current default. `/unset_default_new_topic_skill` removes it and accepts no arguments. The set command has no clearing argument; `clear` remains an ordinary exact skill name.

Future managed topics snapshot that setting when created. The snapshot persists across bot restarts and adds `/skill:exact-name` only to the first accepted Telegram prompt or frozen proposal, together with explicit pending skill selections and without duplicate mentions. For General `/p` and `/new`, the initial task includes the default and proposals freeze that composed text for approval. For a manually created topic, the first accepted Telegram task can come from any authorized user, not just the topic creator. Later forum-default changes do not alter existing topics, their snapshots, or attached histories. This is a Telegram composition default; Mini App submissions do not apply or consume it.

Configured instance admins remain root administrators identified by their Telegram usernames. `/make_admin @username` (or `/make_admin username`) grants access by username; alternatively, reply to a member's message with `/make_admin` and no arguments to grant access by stable numeric Telegram ID. Numeric ID arguments are rejected. Usernames are normalized by removing an optional `@` and lowercasing with the existing configured username grammar. Telegram cannot resolve arbitrary handles, so username promotion does not look up the target; active human membership is checked when the recipient uses permissions. Reply targets must already be active human group members; bots, departed members, and anonymous/channel senders cannot be reply targets. The caller must also be an active human group member.

In General, promotion grants bot-wide administrator access across the chats assigned to that bot. In any other forum topic, promotion grants access only in that topic of that bot/chat assignment. Instance roots and bot-wide admins can promote in either scope; topic admins can promote other members only within their own topic and cannot grant General or bot-wide access. These grants do not make anyone a Telegram group administrator or grant access through other bots. Telegram group-administrator status alone does not grant application-admin permissions; only enrollment of an unassigned group requires it.

Bot-wide grants persist in configuration (`bots[].admins`); topic grants persist in the SQLite runtime database, not configuration. Both survive restarts and store either normalized username strings or numeric Telegram IDs from replies. Username grants follow the current handle; reply grants remain tied to the user ID despite username changes. Existing instance username roots remain unchanged. There is no Telegram demotion command; remove bot-wide grants locally from configuration or topic grants locally from the database to revoke access.

`/list_admins` accepts no arguments and is available to every active human member of the current assigned forum, not only admins. It shows separate global and topic-admin sections. Global admins are the union of the assigned instance's username roots and the current bot's `bots[].admins` grants. In General, the topic section includes grants from all topics in this bot/chat; elsewhere it includes only the current topic. It never lists grants from another chat or bot. Topic entries already represented globally are omitted by normalized username or numeric-ID aliases. Numeric grants display a current `@username` when Telegram's `getChatMember` lookup provides one, otherwise `User ID: <id>`. Listed username grants are not proof that a handle was verified or its owner is still a member: current human membership is required whenever access is used.

Admin listings contain only two unnumbered groups, `Global admins` and `Topic admins`, with one user per line and `none` for an empty group, without an explanatory footer. In a topic, its group heading links to the topic. In General, topic-user entries link to their topic using its name when known rather than displaying a numeric topic ID. Link previews are disabled.

Ordinary group members retain Mini App access, `/stop`, and `/kill`. Prompt restrictions are not access restrictions for the Mini App. See [Projects and access](#2-projects-and-access) before inviting members.

### 1.3. Replies, questions, and activity

The bot mirrors agent replies into the topic. It renders supported Markdown, shows model-provided HTML literally, and leaves unsafe or relative links unlinked. Tables and images become text. Long replies split without breaking formatting or Unicode and retain their native reply target across service restarts. Telegram failure replies include the underlying operation error as a literal code block.

Mini App prompts also appear in the topic with the sender's Telegram username, or their display name and numeric ID if they have no username.

Agent questions include the full text, option descriptions, and numbered option buttons in compact rows of up to five, with Cancel separate. Choose Other to enter a custom multiline answer through Telegram's reply prompt. The answer goes to the question, not the prompt queue. Cancel dismisses it. Answered questions retain a visible number-and-label receipt after their buttons are removed, including long answer labels. Answers from the Mini App or terminal close the Telegram controls too. Current group members can answer; OMP resolves competing responses. Ended or disconnected questions cannot accept answers, and recent stale text replies are rejected rather than submitted as prompts.

| Indicator | Meaning |
| --- | --- |
| 👀 reaction | The bot received eligible input. |
| 🤝 reaction | OMP confirmed receipt. For `/stop`, interruption was confirmed. For `/kill`, the process exited. |
| ⚡ topic icon | An agent turn is running, including tool work. |
| ✅ topic icon | OMP is alive and idle. |
| 🏁 topic icon | OMP is stopped or has not started. |

Approval alone does not produce a receipt reaction. Failed or rejected instructions do not get one. A relay disconnect does not mean OMP stopped. The bot checks liveness every 30 seconds and preserves confirmed icons across restarts. Reactions and icon changes depend on Telegram permissions and rate limits.

Topics created with an initial task start with the ⚡ icon directly and retain it during host startup and initial task admission. Empty topics start stopped.

Host state snapshots reconcile the activity icon: no streaming or queued work clears a stale running indication even if an agent-end event was missed. Agent lifecycle events update the icon promptly between snapshots; pending initial tasks retain the startup indication. The bot removes its own icon-change service notices, not human icon edits or rename notices. Detached topics have no custom activity icon, and later status checks or restarts do not restore one.

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

Each successful startup notifies enrolled groups in General: “OMP bot service is back online (restarting took N.NN seconds).” The duration runs from the preceding orderly shutdown through readiness, including time between processes; without a shutdown timestamp it measures startup. An orderly shutdown sends a winding-down notice.


## 3. Capacity and reconnection

`maxSessions` limits resident managed OMP processes across all bots and projects, not saved conversations. Empty topics consume no process. Hosts idle for five minutes may retire; the runtime tries least-recently-used idle hosts sooner when it needs capacity. Connected Mini Apps and pending or active work protect a host.

Retirement waits for OMP's guarded shutdown and never escalates to signals. This path was verified with OMP 18.13.1. Older hosts without that support are not forcibly retired. `/kill` is separate: it verifies process identity before SIGKILL and waits for exit.

If retirement cannot free capacity, an instance root or bot admin can approve a prompt to double the shared limit. Topic admins cannot approve capacity increases. Approval saves the new limit and retries the pending initial task once. Other prompts must be resent. Protected configuration requires an administrator CLI update instead. Expired or replayed confirmations cannot increase capacity.

OMP's Collab protocol has no prompt admission acknowledgement or idempotency key. The bot marks an initial task submitted before sending it and retries only explicit startup rejection. A crash between those steps may require resending the task. Disconnects never replay possibly executed instructions.

Telegram mirroring retries an unexpected Collab disconnect up to five times with backoff. Recovery delivers unseen assistant entries, not prompts. If it fails, the bot posts a notice; a later authorized prompt can reconnect. Telegram polling retries network failures, rate limits, and server errors. Invalid credentials and polling conflicts stop the service.

The Mini App retains its transcript and draft during transient failures. Reconnects use capped exponential backoff and a fresh single-use ticket with renewed authentication and membership checks. They do not queue or replay instructions. Leave, denied membership, expired launch credentials, invalid actions, or full capacity stop automatic reconnect. Use Rejoin after capacity becomes available. Reopen OPEN AGENT when Telegram credentials expire.

## 4. Attached sessions and transcript

Instance roots and bot admins can attach a control-shared OMP host whose working directory matches the assigned project; topic admins cannot. Attached hosts survive service shutdown. Killing one requires restarting it locally and attaching the replacement.

The Mini App collapses IRC traffic, system notices, reminders, task-result envelopes, and displayed custom notices. Disclosures reveal their contents. Ordinary prose, attachments, code examples, unknown tags, and incomplete envelopes stay visible. Hidden custom entries remain hidden.

Mini App participant names and new transcript prompts use the signed Telegram `@username`, falling back to `user ID <id>` when no username is set. Avatar initials use the username without its `@` prefix.
