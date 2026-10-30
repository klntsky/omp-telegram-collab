# Product

This document defines current user-visible behavior. See [Development](DEVELOPMENT.md) for setup and operations.

The Mini App is optional. Setup explains that it adds a live transcript, tool details, and subagent controls before asking whether to enable it. New services default to Telegram-only.

An empty public HTTPS origin selects Telegram-only operation for every bot in the service. Prompts, images, replies, agent questions, and Telegram session commands remain available. Mini App launch buttons and `/session` menu entries appear when an HTTPS origin is configured. Enabling the Mini App requires a named app registered in BotFather for each bot. A network failure leaves the configured mode unchanged.

The `/cli` command works in both modes. Its code block and copy button contain only the chat and topic IDs. Requesting the command leaves the host unchanged. Executing it locally resolves the current assignment through the running service, resumes a managed host when needed, and joins the live conversation. Closed, detached, missing, ambiguous, unassigned, and terminated sessions are rejected. Leaving the terminal client leaves the host and Telegram conversation running.

Local terminal access uses the service account's operating-system permissions. Copying the Telegram command grants no access on another machine. Connection capabilities are resolved on the service machine and passed to the local OMP client; local process inspection is within that machine's trust boundary.

## 1. Telegram sessions


### 1.1. Sessions and commands

| Command or action | Result |
| --- | --- |
| `/new <task>` | Create a topic and submit its first task. Bare `/new` asks for the task. |
| `/worktree [branch]` | Run OMP's native worktree operation in the current topic's managed session. In General, create an empty session topic first. The optional argument is a branch name, not a task. |
| Create a topic manually | Register a session. OMP starts on the first instruction or Mini App visit. |
| `/p <prompt>` | Submit a prompt in explicit-command mode. In General, create a topic like `/new`. |
| `/skills` | Pick skills to mention in your next accepted prompt in this topic. `/skills clear` clears your pending selection. |
| `/settings` | Open interactive forum settings, defaults, and the live session count limit. Requires the current supergroup owner or an administrator. |
| `/session` | Get the current topic's Mini App link when the Mini App is enabled. |
| `/cli` | Get a copyable terminal join command for the current open session topic. Requires the current supergroup owner or an administrator. |
| `/stop` | Interrupt the current agent turn without terminating OMP. |
| `/kill` | Force-terminate the topic's OMP process, even while busy. In-flight work may be lost. |
| `/terminate` | Supergroup owner or administrator service-wide break: persist `terminated: true`, force-kill all session hosts across bots, and keep the bot online. |
| `/detach` | Make the topic permanently conversation-only. Requires the supergroup owner or an administrator. |
| `/attach INSTANCE_ID` | Connect a running OMP host to a new topic. Requires the supergroup owner or an administrator. |
| `/model_preset [name]` | List available presets and the current selection, or switch an idle topic's session by name. Requires the supergroup owner or an administrator. Forum defaults are managed through `/settings`. |
| `/list_admins` | List the current human supergroup owner and administrators. Available to current group members in General and topics. |
| `/setup` | Request or complete forum enrollment, then open `/settings`. |
| `/status` | Show forum, host, mirroring, task-admission, recovery, skill-cache and failure diagnostics. Current members can inspect assigned forums, including during service termination. Accepts no arguments. |
| `/usage` | Show usage, limits, remaining quota and available reset times for authenticated providers used by the assigned OMP environment. Available to authorized forum members in General and topics; accepts no arguments and never starts a session host. Account emails and IDs are omitted. Reports may be cached by OMP; unavailable quota values are shown as unknown. |
| `/help` | Show commands and prompt settings. |

Commands are recognized in message text and at the start of media captions, even without Telegram command entities. Caption commands use the same bot targeting, permissions, prompt settings, and handlers as text commands.

Photos and JPEG, PNG, WebP, or GIF image documents accompany their prompt as image content, not links or filenames. `/new` and `/p` captions submit the image with their instructions. In all-message mode, session-topic images use their caption as the prompt, or “Describe this image.” when no caption is present. Explicit-command mode ignores images without a prompt command unless they reply to this bot. The largest photo size is used; image documents retain their original bytes. Image albums are combined as described in [Prompts and permissions](#12-prompts-and-permissions). Model image support is required.

General never becomes a session. `/stop` and `/kill` work only in session topics and require current group membership. Neither starts an idle host. Both cancel pending initial tasks, startup retries, and capacity confirmations.

New session topics get a quietly pinned OPEN AGENT message before OMP starts. The bot returns a topic link in the originating conversation when `/new` or `/attach` creates a topic, including an interactive task reply. For `/new` or `/p` creating a topic, it forwards any replied-to message below the pin, then the original task message, without submitting the prompt twice. This includes replied-to media without text or captions. Interactive task replies do not forward the bot's task-request message.

`/worktree` delegates worktree creation, uncommitted-change transfer, and session relocation to OMP's own command. In a session topic it keeps the same topic and conversation history. The session retains its configured project assignment and authorization while its execution directory changes. Worktree location, branch defaults, change transfer, and source-checkout cleanup follow OMP's settings. Worktrees are not automatically removed when sessions stop or the service restarts.

A current supergroup owner or administrator can invoke `/worktree` in an active managed topic. The host must be idle. Attached hosts remain terminal-owned; run `/worktree` in their local OMP terminal. General creates a new empty topic before invoking the native command, with the same administrator or proposal-approval rules as new-topic creation. Branch arguments are not submitted as prompts and do not consume pending skills. Native failures retain OMP's original diagnostics.

The pinned message contains only “Use /p to submit a prompt” in explicit-prompt mode or “Send a message to prompt the agent” in all-messages mode, plus the OPEN AGENT button.

Admin-only button denials appear as callback-query toasts, not chat messages. Command denials remain chat replies.

The service becomes ready after mandatory runtime/history checks, bot identity and cached-command setup, HTTP binding, and the first successful Telegram poll for every configured bot. Session restoration, status maintenance, and fresh skill discovery run afterward without delaying readiness. A slow project's discovery does not delay another project's command-menu refresh.

Online notices are sent after readiness; slow notice delivery does not hold startup open. An orderly shutdown cancels unfinished background refreshes and online notices, drains input acknowledgements, and attempts winding-down notices while teardown proceeds. Restart notices retain the end-to-end downtime measurement; readiness does not imply that every session has already reconnected. Assignment removal disables access immediately and listener cleanup and configuration acknowledgement do not wait for skill discovery.

`/status` is read-only: it does not start hosts, reconnect sessions, retry tasks, or discover skills. General shows forum and project-catalog state without listing other topics. A session topic also shows observed host liveness, mirror connectivity, the latest observed Telegram task's admission state, and scheduled or active recovery. Failed host inspection reports unknown, not stopped; losing mirroring does not imply that the host or task stopped. Unconfirmed admission becomes unknown on disconnection, and an admission receipt is not proof of task completion.

Status retains the latest relevant session and project-catalog failures with operation, observation timestamp, and exact original diagnostics, including multiline messages and available subprocess fields. These observations are scoped to the current bot, assignment and topic and reset on bot restart; historical failures may remain visible after recovery. Skill catalogs persist, but a saved catalog's original discovery timestamp may be unknown. The successful-check timestamp describes this process's catalog check and may use the runtime discovery cache. No additional progress or failure notifications are sent.

Session titles and Telegram topic names synchronize in both directions. Telegram adds Git status before the readable title. A linked worktree on a non-default branch displays `wt:branch/name Readable title`; a linked worktree on the default branch displays `wt: Readable title`. An ordinary checkout on a non-default branch displays `branch/name Readable title`. The default branch without a linked worktree displays only the readable title. Git status is refreshed from the actual session checkout, including reconnects and worktree transitions.

Renaming a topic updates the actual OMP session title without submitting a prompt or starting a stopped host; pending renames survive service restarts and apply when the managed host next starts. Previously generated status is removed from human edits, and the current status is restored even when the user deletes it or the host cannot accept native title changes. Generated status never becomes part of the OMP title. OMP title changes update the readable portion while mirroring is connected, including automatically generated titles. Telegram displays at most 128 Unicode characters including status; the full OMP title remains intact. Long status prefixes are shortened with an ellipsis to reserve space for up to 64 readable-title characters. Detached topics no longer synchronize titles.

Telegram-to-OMP renames require a host with session-title control support. Terminal-owned attached hosts without that support report a control error rather than claiming their title changed; OMP-to-Telegram mirroring remains available.

Close a topic to archive instructions; reopen it to resume. Closing or deleting a topic does not delete OMP history. Telegram has no documented topic-deleted service update, so deletion is not a reliable cleanup signal.

`/kill` preserves history and invalidates existing Mini App connections, including automatic reconnects. A later instruction, Rejoin, or fresh OPEN AGENT visit can resume a managed session. `/detach` instead disables prompts, reactions, mirroring, approvals, and Mini App access permanently for that topic. It preserves history and does not kill the host. Use `/new` for another session.

While terminated, prompts, callbacks, Mini App agent access, and commands other than read-only `/status` are blocked. Blocked commands receive “The service got terminated, only admin can resume it (remove terminated: true from the config)”. Current human members may still inspect status for an assigned, enrolled forum; status does not resume the service or query suspended hosts. Pending initial tasks and approvals are cancelled; histories remain intact. Only an operator with configuration access can resume service by removing the top-level flag. Restarting the bot does not clear termination.

### 1.2. Prompts and permissions

Each bot/chat assignment has two prompt-policy settings. `/settings` opens the same forum-wide controls from General or any topic. The root panel shows current values. Buttons open choices for prompt policy, user proposals, default new-topic skill, default model preset, and Live session count limit. Back returns to the root panel, and Close dismisses the controls. Changes edit the existing panel rather than posting a new menu for each click.

Live session count limit applies across all bots and instances. Administrators reply to its panel with any whole number ≥1 within JavaScript's safe integer range, then confirm the change. Both increases and decreases are supported. Lowering the limit leaves existing sessions running and prevents new starts until usage falls below the limit. Settings changes do not submit or retry tasks.

Settings catalog failures preserve the displayed controls so administrators can retry or close the panel. Panels lost after a service restart explicitly direct users to reopen `/settings`. Replies to settings panels remain control input and never become agent tasks.

| Setting | Default | Effect |
| --- | --- | --- |
| `all_messages_are_prompts` | `true` | Session-topic text and images become prompts. When `false`, use `/p <prompt>` or reply to this bot's messages. Ordinary discussion, mentions, and replies to other users or bots are ignored. |
| `users_can_propose_prompts` | `false` | Prompts without sufficient administrator scope are ignored. When `true`, an authorized admin must approve them. Authorized admin prompts run directly. |

`/p` works in either prompt mode, including `/p@YourBot <prompt>`. Both `/p` and `/new`, including bot-qualified forms, prepend replied-to text or media captions with `> ` on each line, followed by a blank line and any supplied instructions. Bare commands with a text or caption reply submit just the quote. For `/new`, or `/p` in General, the combined text becomes the new session's initial task. Existing authorization and proposal approval still apply. Replies without text or a caption contribute no quote.

Reply quotes never attach the quoted message's photos or image documents to the AI prompt. Only images uploaded in the new prompt message or its album are attached. Forwarding the quoted message into a newly created topic does not submit its media to the AI.

Non-command replies to this bot's own messages behave as `/p` in either mode: they include the same quote and, in General, create a new session and forward both the quoted message and the user's reply below its pin. Authorization and proposal approval remain unchanged. Interactive task-request replies and active or expired agent-question replies retain their dedicated handling; detached topics remain conversation-only.

Telegram's implicit reply to a topic's creation message is topic-routing metadata, not an intentional reply to the bot. Ordinary messages with that metadata remain ignored when `all_messages_are_prompts` is `false`, including topics created by this bot.

Other commands, forwarded messages, and bot messages are not prompts. Non-admin `/new` requests follow the proposal setting too.

The current human supergroup owner and administrators can submit `/new`, `/p` in General, and existing-topic prompts directly, and approve proposals throughout that group. Telegram status `creator` or `administrator` grants this authority, even without a username or optional moderation permissions. Ordinary members follow the configured proposal policy. Authority does not cross group or bot assignments.

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

The default new-topic skill picker in `/settings` updates the per-bot/chat forum default without changing the current session. Only the current supergroup owner and administrators can change it. The exact canonical name must exist in the assigned project's skill catalog and contain no whitespace, control characters, or backslashes. Case, punctuation, and namespaces are preserved. The picker includes a separate control to clear the default, so `clear` remains an ordinary exact skill name.

Future managed topics snapshot that setting when created. The snapshot persists across bot restarts and adds `/skill:exact-name` only to the first accepted Telegram prompt or frozen proposal, together with explicit pending skill selections and without duplicate mentions. For General `/p` and `/new`, the initial task includes the default and proposals freeze that composed text for approval. For a manually created topic, the first accepted Telegram task can come from any authorized user, not just the topic creator. Later forum-default changes do not alter existing topics, their snapshots, or attached histories. This is a Telegram composition default; Mini App submissions do not apply or consume it.

Telegram owns administrator promotion and demotion. Manage roles through Telegram's native group administrator settings, including its granular delegation rules. The bot does not promote users, persist administrator grants, or provide separate bot-wide or topic-local roles. Usernames are display identities, not authorization grants.

Administrator checks use current Telegram membership. Promotion grants OMP control throughout the assigned group; demotion removes it on the next authorization check. Already admitted operations are not retroactively cancelled. Telegram lookup failures do not fall back to stored grants. Anonymous messages sent as a group or channel cannot establish an individual administrator's authority.

Pending initial tasks also retain the approving administrator's identity. Before submission after startup, recovery, or an explicit startup rejection, that person must still be an owner or administrator and the proposer must still be a current member. Confirmed membership loss or administrator revocation cancels a pending task; it must be submitted again. A failed Telegram lookup or lifecycle cancellation prevents submission but preserves the unsent task for a later authorized recovery. Failures retain their original diagnostics.

`/list_admins` accepts no arguments and is available to every active human member of an assigned, enrolled forum, in General or a topic. It fetches Telegram's current administrator roster, includes the owner, and excludes bots. Entries show a username when available or a display name and numeric user ID otherwise. The roster is informational and is not reused to authorize later actions.

Ordinary group members retain watch-only Mini App access and the Telegram `/stop` and `/kill` commands. Mini App control requires current supergroup owner or administrator status, independently of Telegram prompt settings. See [Projects and access](#2-projects-and-access) before inviting members.

### 1.3. Replies, questions, and activity

The bot mirrors agent replies into the topic using Telegram rich messages with native rich Markdown, including headings, lists, tables, formulas, and media supported by Telegram. Agent Markdown is sent directly, not converted into ordinary-message HTML or flattened preformatted tables. Long replies split at Markdown block boundaries where possible within the rich-message text limit; oversized code blocks remain fenced and Unicode characters are not split. A single oversized non-code block may span messages. Replies retain their native reply target across service restarts. Telegram failure replies include the underlying operation error as a literal code block.

Mini App prompts and text answers to agent questions also appear in the topic with the sender's Telegram username, or their display name and numeric ID if they have no username. Text answers preserve multiline content and go to the question, not the prompt queue.

Agent questions include the full text, option descriptions, and numbered option buttons in compact rows of up to five, with Cancel separate. Choose Other to enter a custom multiline answer through Telegram's reply prompt. The answer goes to the question, not the prompt queue. Cancel dismisses it. Answered questions retain a visible number-and-label receipt after their buttons are removed, including long answer labels. Answers from the Mini App or terminal close the Telegram controls too. Current group members can answer; OMP resolves competing responses. Ended or disconnected questions cannot accept answers, and recent stale text replies are rejected rather than submitted as prompts.

| Indicator | Meaning |
| --- | --- |
| 👀 reaction | The bot received eligible input. |
| 🤝 reaction | OMP confirmed receipt. For `/stop`, interruption was confirmed. For `/kill`, the process exited. |
| ⚡ topic icon | An agent turn is running, including tool work. |
| 🏁 topic icon, or your chosen topic icon | No agent turn is running, whether the host is idle, stopped, or not started. |

Approval alone does not produce a receipt reaction. Failed or rejected instructions do not get one. A relay disconnect does not mean OMP stopped. The bot checks liveness every 30 seconds and preserves confirmed icons across restarts. Reactions and icon changes depend on Telegram permissions and rate limits.

Topics created with an initial task start with the ⚡ icon directly and retain it during host startup and initial task admission. Empty topics start with the finish icon.

Changing a topic icon saves it as that topic's finish icon, regardless of session activity when you choose it. The choice persists across bot restarts and host stops or resumes. Running turns still use ⚡ and restore your choice when finished. Icon choices are used verbatim, including an empty icon or an activity icon you selected. Bot-authored icon changes do not replace your saved choice. The bot does not use a separate green-checkmark state for idle live hosts.

Host state snapshots reconcile the activity icon: no streaming or queued work clears a stale running indication even if an agent-end event was missed. Agent lifecycle events update the icon promptly between snapshots; pending initial tasks retain the startup indication. The bot removes its own icon-change service notices, not human icon edits or rename notices. Detached topics have no custom activity icon, and later status checks or restarts do not restore one.

Telegram delivery uses a per-chat queue with no fixed delay between operations. Questions and receipts take priority over icon updates. A Telegram `429` pauses that chat's delivery for `retry_after`, then retries the operation if it is still relevant. A `429` without `retry_after` uses a five-second cooldown. Ambiguous network failures are not retried automatically.

### 1.4. Model presets

The Default model preset picker in `/settings` saves or clears the default for that bot/chat assignment. New managed hosts apply its models and thinking settings before accepting work, including when resuming history. It overrides restored settings and model-selection flags. Running hosts do not change. A missing saved preset fails startup rather than selecting another one.

In a session topic, `/model_preset` starts the host if needed and lists presets and the current selection. `/model_preset <name>` switches only that idle session. Usage replies include available presets. The command-menu description explains both forms and includes as many complete preset names as fit Telegram's limit, preferring shorter names. Menu preset names refresh in the background; discovery failures retain the last successful names and their original diagnostics. Neither form changes the forum default. Attached hosts must use `/modelpreset` in their local terminal. Older managed hosts that cannot switch without changing shared settings must be restarted first.


## 2. Projects and access

A project is identified by its canonical directory. Several chats can share a project. Each topic keeps separate history. Ordinary sessions share the configured checkout's working files; `/worktree` sessions use separate Git worktrees. Removing a chat disables access and mirroring without deleting history or killing hosts. A chat with saved topics cannot move to another project.


OMP runs with the service account's filesystem and credential access. Project registrations and Telegram roles do not isolate processes. Use a dedicated account or container if users must not access other checkouts or writable configuration.

Current human group members can watch sessions and fetch transcripts through the Mini App. The current supergroup owner and administrators can submit prompts, interrupt, chat with or kill/revive subagents, or answer agent questions through it. No particular optional Telegram moderation permission is required for OMP control. Archived sessions and host read-only restrictions remain read-only even for administrators. Opening the Mini App can still start a stopped host. Local operators control which project each bot/chat pair may access; Telegram roles cannot create or override that assignment.

The backend checks Telegram's signed Mini App data, its age, and its session parameter for the initial exchange, then issues a long-lived credential bound to the bot, session, and user. This backend credential has no time expiry and survives service restarts while the bot token remains unchanged. The Mini App caches it in memory and session storage for the current launch, scoped to the bot and session, so reconnects and reloads do not require fresh Telegram launch data. Current group membership is checked on reconnect, before writes, and periodically for active sockets; confirmed membership loss revokes access and closes the connection. Reads reuse the established authorization instead of repeating Telegram checks for each snapshot, output frame, or transcript request. Single-use tickets still authorize WebSocket upgrades. The displayed control role reflects admission, not permission to execute a later write. Every queued mutation receives a fresh server-side authority check before prompt accounting, upstream forwarding, or Telegram relay. Join-triggered host startup, capacity retirement, and mirroring side effects also check current membership at their mutation boundaries; ordinary members may still start a stopped host. Local termination, assignment, enrollment, detachment, and session generation remain enforced throughout the flow. Browser state and connection closure are not authorization boundaries. Unknown actions are denied. Links contain opaque mapping IDs; OMP room keys and write tokens stay on the server. Forwarding a Mini App link does not grant membership. Revocation does not cancel work already admitted.

A kill advances a persistent session generation before notification or termination. Ticket refreshes, socket upgrades, host admission, and mirroring reject the old generation. Automatic reconnect cannot revive a killed session. Explicit Rejoin gets the current generation.

Separately shared OMP Collab links bypass this Telegram gateway. Telegram membership changes cannot revoke those capabilities. Do not distribute them if membership is your intended access boundary.

Keep the YAML and runtime data private. They contain bot tokens, topic mappings, and OMP histories. Service shutdown does not delete history.

Each successful startup notifies enrolled groups in the reserved **Bot status** forum topic: “OMP bot service is back online (restarting took N.NN seconds).” The bot creates this topic when needed and persists its ID separately for each bot and chat. Later lifecycle notices reuse it; if Telegram reports that the message thread no longer exists, the bot creates a replacement and saves its ID. Notices never fall back to General. The duration runs from the preceding orderly shutdown through readiness, including time between processes; without a shutdown timestamp it measures startup. An orderly shutdown sends a winding-down notice in the same reserved topic.

Bot status is not a session topic. Messages there are ignored before command handling, prompt submission, or receipt reactions: slash commands (including `/terminate`, `/setup`, and `/new`), ordinary text, and replies to the bot have no effect. Use General or a session topic for commands and prompts.


## 3. Capacity and reconnection

`maxSessions` limits resident managed OMP processes across all bots and projects, not saved conversations. Empty topics consume no process. Hosts idle for five minutes may retire; the runtime tries least-recently-used idle hosts sooner when it needs capacity. Connected Mini Apps and pending or active work protect a host.

Automatic retirement requires the host to confirm that it is idle and has no pending messages. Hosts without safe retirement support remain running. A timed-out request cancelled before acceptance cannot retire the host later. Accepted retirement blocks new submissions while the host finishes shutting down; an observation timeout does not cancel accepted retirement. Retirement never escalates to signals. `/kill` is separate: it verifies process identity before SIGKILL and waits for exit.

If retirement cannot free capacity, the current supergroup owner or an administrator can approve a prompt to double the shared service-wide limit. Approval saves the new limit and retries the pending initial task once. Other prompts must be resent. Protected configuration requires an operator CLI update instead. Expired or replayed confirmations cannot increase capacity.

OMP's Collab protocol has no prompt admission acknowledgement or idempotency key. The bot marks an initial task submitted before sending it and retries only explicit startup rejection. A crash between those steps may require resending the task. Disconnects never replay possibly executed instructions.

Telegram mirroring retries an unexpected Collab disconnect up to five times with backoff. Recovery delivers unseen assistant entries, not prompts. If it fails, the bot posts a notice; a later authorized prompt can reconnect. Telegram polling retries network failures, rate limits, and server errors. Invalid credentials and polling conflicts stop the service.

Failure to acquire or reconnect to an existing managed host does not retire it. The original connection diagnostic is preserved, and a later attempt can reconnect to the same host.

New managed hosts remain in startup when Collab discovery temporarily reports that a just-discovered host is absent. Recovery uses the original startup deadline and revalidates host identity before connecting. If discovery remains unavailable, startup fails with the original diagnostic. Other connection and identity failures are not retried by this startup recovery.

The Mini App retains its transcript and draft during transient failures. Automatic reconnects use capped exponential backoff, the cached long-lived backend credential, and a fresh single-use ticket with current membership checks. Service restarts and the age of the original Telegram launch do not require reopening Telegram after the initial exchange. Reconnects do not queue or replay instructions. Leave, denied membership, invalid credentials or actions, a killed session, or full capacity stop automatic reconnect. Use Rejoin after capacity becomes available or to resume a killed session explicitly. Backend errors retain their original diagnostics rather than being replaced with expired-launch instructions.

Transient Telegram authorization lookup failures fail closed without becoming permanent access denials. Transport failures, ten-second lookup deadlines, Telegram rate limits (429), and Telegram server errors (5xx) refuse gateway admission with HTTP 503 or close an active socket with code 1013, retaining the original diagnostic. The Mini App silently retries through its existing reconnect flow and rechecks current access; it does not replay the blocked action. Other Telegram 4xx responses, confirmed membership loss, and local access denials remain non-recoverable access failures. Abandoned Mini App authentication requests cancel their lookups and promptly release authentication capacity.

## 4. Attached sessions and transcript

The current supergroup owner and administrators can attach a control-shared OMP host whose working directory matches the assigned project. Attached hosts survive service shutdown. Killing one requires restarting it locally and attaching the replacement.

The Mini App collapses IRC traffic, system notices, reminders, task-result envelopes, and displayed custom notices. Disclosures reveal their contents. Ordinary prose, attachments, code examples, unknown tags, and incomplete envelopes stay visible. Hidden custom entries remain hidden.

Mini App participant names and new transcript prompts use the signed Telegram `@username`, falling back to `user ID <id>` when no username is set. Avatar initials use the username without its `@` prefix.
