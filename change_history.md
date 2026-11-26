# [ef3b9ca7b2c4c1b9c6692201dfc17b644166825c](https://github.com/klntsky/omp-telegram-collab/commit/ef3b9ca7b2c4c1b9c6692201dfc17b644166825c)

# [ca802773aff82a6740dedf6df87e3ba23f0c3eed](https://github.com/klntsky/omp-telegram-collab/commit/ca802773aff82a6740dedf6df87e3ba23f0c3eed)

Expose local OMP coding conversations through user-owned Telegram bots and forum topics, with Telegram and an integrated Mini App controlling the same session. Keep deployment self-hosted, using the operator's OMP installation, model credentials, groups, and public HTTPS endpoint.

Configure the service through environment variables and load the working directory's `.env` during startup, with exported values taking precedence. Require bot credentials, owner usernames, and a public HTTPS origin. Match usernames case-insensitively with an optional `@`. Support multiple named bots with independent credentials, owners, and Mini App names. Allow configuration of the listener, data directory, OMP executable and working directory, process limit, startup timeout, relay, and numbered literal OMP arguments without shell evaluation. Reject invalid configuration without exposing credentials.

Require explicit `/setup` enrollment by a configured owner who is currently a group administrator in a Topics-enabled supergroup where the bot can manage topics. Provide private onboarding, an add-to-group link, readiness guidance, Check Again, `/status`, and `/help`. Verify the caller's current username and administrator status for enrollment and attachment rather than reusing a remembered identity.

Allow current members to create a dedicated session topic with `/new task` or provide its task interactively through bare `/new` or New Session. Bind interactive requests to their requesting user. Initialize sessions for manually created topics except General, announce readiness, and expose Open Session and `/session` links.

Accept session-topic instructions through bot mentions or replies to this bot, removing addressing mentions from the submitted text. Ignore ordinary discussion, forwarded instructions, bot-authored instructions, and commands addressed to another bot. Allow current members to interrupt work with `/stop`. Mirror completed assistant text into the topic and split long messages without breaking Unicode surrogate pairs.

Allow an owner who is currently a group administrator to attach a control-enabled local OMP host with `/attach INSTANCE_ID [topic name]`, creating a new topic without posting a capability link. Preserve its identity and terminal ownership, leaving attached processes running when the service stops.

Persist enrollment and bot/topic/session mappings across restarts. Resume managed sessions using their exact saved history and identity, rejecting incompatible or changed histories. Prevent two service instances from managing the same data directory and enforce the configured managed-process limit. Save topic renames, archive closed topics, reject archived instructions, and permit instructions after reopening. Preserve histories on closure and shutdown and allow read-only Mini App access to archived sessions.

Authenticate Mini App launches using signed, time-limited Telegram data and the signed session selection. Require current membership in the enrolled forum and the bot's required permissions. Authorize live connections, actions, and deliveries independently so forwarding a link does not grant access. Keep OMP room capabilities and write credentials server-side and require fresh authorization on rejoin.

Provide a Mini App transcript with live assistant output, earlier history, Markdown, mathematics, message images, expandable thinking, tool-call and result details, and visible failures or aborted responses. Preserve the reader's position when inspecting earlier messages. Show connection state, title, working directory, model, thinking level, context usage, and participants.

Allow writable Mini App participants to submit prompts, inspect queued-message counts, interrupt turns, and answer or cancel selection and text-entry questions. Use Enter to submit and Shift+Enter for a newline without submitting during input-method composition. Disable instruction controls for read-only or unavailable sessions.

Provide an agent panel with main-agent and subagent activity, lifecycle state, and available token, cost, timing, model, and context information. Allow transcript inspection, agent messages, stopping running agents, and reviving parked or aborted agents. Hide mutation controls for read-only sessions and report unavailable transcripts. Adapt to Telegram viewport and theme changes, offer system/light/dark themes, and provide Leave, Retry, and Rejoin.

Retry unexpected mirroring disconnections up to five times with backoff, recovering unseen assistant entries without replaying possibly executed prompts. Notify the topic after recovery fails and allow a later mention to reconnect. Retry initial tasks only after explicit startup rejection and explain when resubmission is required. Retry temporary Telegram polling failures, rate limits, and server errors; stop for invalid credentials or polling conflicts.

# [dcabad02f50b0b733836261a44e11113ee1340e4](https://github.com/klntsky/omp-telegram-collab/commit/dcabad02f50b0b733836261a44e11113ee1340e4)

Route General `/p` through new-session creation in either prompt mode, including bot-qualified commands and interactive task replies. Publish `/p` and the other supported commands in group-wide and chat-specific menus. Keep General separate from sessions.

Default session-topic ordinary-message prompting to enabled and non-admin proposals to disabled for each bot/chat assignment. In explicit-command mode, accept `/p <prompt>` and ignore ordinary discussion, mentions, and replies. Allow configured instance admins who are current members to submit directly without requiring Telegram administrator status. When proposals are enabled, show non-admin prompt text for one-time admin approval, including new-topic tasks. Preserve original text and reply targets, expire proposals after ten minutes or restart, and invalidate them after policy or assignment changes, archival, kill, or proposer departure.

Let current group administrators request local-operator approval for unassigned forums through `/setup`. Let assigned-instance admins enroll groups and change prompt settings without Telegram administrator status. Require Manage Topics and Pin Messages permissions and recheck assignment and administrator authority before saving settings. Respect protected configuration instead of changing only runtime state.

Create empty manually made topics without starting a host until an instruction or Mini App visit. Quietly pin Open Session before host startup. Reply to topic-creation requests with a direct link in the originating conversation. Copy the initial task below the pin with participant attribution without submitting it twice.

Provide instance-admin preset listing and switching inside open managed topics, without model prompts. Start the host on demand, require idle switching, recheck access after startup, preserve native results, and reject archived, attached, or unsupported hosts.

Show agent questions in Telegram with complete Unicode-safe text, option descriptions, checked selections, and numbered buttons in rows of up to five with Cancel separate. Accept multiline custom answers through a native reply prompt and send them as question responses rather than tasks. Permit current members to answer, close controls after external answers or disconnection, and reject stale question replies. Replace answered controls with a persistent number-and-label receipt that retains long labels.

React with 👀 on eligible input and replace it with 🤝 only after matching live prompt receipt, custom-answer completion, interruption confirmation, or verified kill completion. Do not acknowledge rejected input, unrelated completions, transcript replay, or a stop with no running host. Preserve native reply targets on every assistant chunk and across restarts; clear Telegram targeting when another participant supplies the prompt. Include the underlying operation error literally in failure replies.

Use ⚡ for running work, ✅ for a live idle host, and 🏁 for a stopped or unstarted host. Observe local-terminal and Mini App activity, distinguish relay loss from process exit, and check liveness every 30 seconds without starting empty topics. Persist confirmed icons to avoid unchanged writes across restarts. Delete the bot's own icon-only service notices while preserving human edits and rename notices.

Restrict `/stop` and `/kill` to session topics and current members, without starting idle hosts. Cancel pending initial work, startup retries, and capacity confirmations. Preserve history after force-kill, advance the persistent session generation before invalidating joins, and permit later explicit resumption. Offer an expiring, one-time instance-admin confirmation to double and persist the shared capacity limit, rejecting stale or replayed approvals and requiring local updates for protected configuration.

Allow instance admins to detach a topic permanently, cancelling interactions, mirroring, prompts, reactions, approvals, and Mini App joins while preserving history and the host. Set the ordinary conversation icon after pending activity writes settle, and prevent lifecycle events or restarts from restoring bot activity icons.

Require PM2 restarts to use `--no-treekill` so independently supervised OMP hosts retain accepted work instead of receiving recursive deployment-stop signals.

# [546984725347ec84228b042607caefa84fc859a3](https://github.com/klntsky/omp-telegram-collab/commit/546984725347ec84228b042607caefa84fc859a3)

Reject fresh and existing Mini App access to detached topics and disconnect affected viewers on detachment or kill. Check persisted session generations before and after asynchronous authorization and during WebSocket admission, returning terminal HTTP 409 for stale refreshes. Reject changed or unavailable canonical project assignments.

Identify Mini App participants and new transcript prompts by signed `@username`, falling back to `user ID <id>`. Mirror Mini App prompts literally into the matching Telegram topic with authenticated attribution and Unicode-safe splitting.

Authorize frozen outbound frame batches with a fresh membership check, leaving frames arriving during that check for the next batch. Preserve ordered streaming without checking membership for every token or reusing an earlier batch's authorization.

Retain hosts while Mini App viewers are connected, ensure Telegram mirroring when a viewer joins, and report capacity refusal without endless reconnection. Keep closed sessions read-only. Permit interactive new-session task replies from detached topics to create a separate session, and clean up the bot's icon-change notices without restoring detached-topic activity.

# [8ce98bffd958717010bfe5213215a0d52c6a075e](https://github.com/klntsky/omp-telegram-collab/commit/8ce98bffd958717010bfe5213215a0d52c6a075e)

# [c1b5b923a7fb7b24df7d1741cf88836a3c75c2ee](https://github.com/klntsky/omp-telegram-collab/commit/c1b5b923a7fb7b24df7d1741cf88836a3c75c2ee)

Replace environment-only configuration with CLI-managed YAML selected by `--config PATH`, defaulting to the XDG configuration directory or `~/.config/omp-telegram/config.yaml`. Support multiple bots, canonical project-directory instances, instance admins, and unique bot/forum assignments with independent prompt settings. Allow incomplete setup but require bots and a public HTTPS origin before startup. Reject invalid fields, duplicate keys or assignments, mismatched bot identities, unsafe OMP arguments, and symlink configuration files. Create credentials privately, preserve existing ownership and mode, and refuse protected or concurrently changed configuration writes.

Provide interactive setup and scriptable commands for instance registration, inspection, removal, administrator management, chat assignment, and bot management. Require an existing canonical directory and an administrator for registration. Require explicit bot selection in ambiguous automation. Preserve histories on removal and prevent deleting registrations with assigned forums. Accept bot tokens through hidden prompts, standard input, or a selected environment variable, verify their Telegram identity, reject duplicates, and omit tokens from listings.

Validate forum Topics and bot Manage Topics and Pin Messages permissions before assignment. Preserve omitted prompt-policy choices on updates. Reject assignment changes that retarget stored histories. Persist setup requests for ten minutes, replacing the same requester's earlier request. Allow local approval into an existing or newly registered project, rechecking requester identity, administrator status, expiry, and confirmation before saving. Preserve unsuccessful requests, consume successful ones, grant the requesting username instance-admin access, and notify the forum.

Apply saved configuration automatically or through `reload`. Apply instance, administrator, chat, and limit changes without restarting bots. Restart runtime components for other service changes and restore the previous configuration if replacement startup fails. Reject history-conflicting reloads and control requests for another configuration file. Report configuration that was saved but could not be applied. Notify assigned enrolled forums after successful polling startup and during orderly shutdown; stop the service on fatal polling failure.

Allow instance admins to list project presets in General without starting a host and save a validated default independently per bot/forum. Show that default when listing presets in work topics. Apply its role models and thinking settings before new or resumed managed hosts accept instructions or joins, overriding restored settings and model-selection flags without changing running hosts. Use ordinary OMP selection when no default exists and fail explicitly for missing, invalid, unavailable, or unusable saved presets.

Make idle work-topic preset switches affect only the running session without persisting shared OMP settings, restoring prior overrides on failure. Reject attached, unsupported, retiring, or identity-changed hosts. Discover presets using the project's native settings and configured profile or config-file selection.

Pin topic histories to their canonical project directories and reject mismatched bindings, history identities, or attachment directories. Preserve active managed work across service shutdown and rediscover surviving hosts after restart. Retire eligible hosts after five idle minutes or reclaim least-recently-used idle hosts under capacity pressure. Count surviving hosts toward capacity and protect busy work and active interactions. Use guarded shutdown without escalating retirement to signals.

Implement force-kill for identified managed and attached processes while preserving history. Support startup cancellation and serialize competing starts and kills. Refuse termination when process, executable, registry, project, session, or history identity cannot be established. Release terminated managed ownership so a later explicit launch can resume saved history.

Pace queued Telegram operations independently per chat at 3.1-second intervals, prioritize foreground interactions over icons, honor explicit rate-limit delays, discard stale operations, and cancel queued delivery at shutdown. Keep ambiguous network failures from automatically replaying operations.

Render assistant Markdown with Telegram-supported headings, emphasis, strikethrough, code, quotations, lists, and safe links. Keep raw HTML literal and unsupported links readable, render tables and images as text, preserve code whitespace, and split long output into independently valid formatted messages without breaking Unicode or counting markup against decoded-text limits.

Accept live Collab broadcasts before welcome while retaining snapshot and session validation and rejecting snapshots that precede welcome.

# [5c3d29bc3b0f5c2c7fb1d61a095624f869751bae](https://github.com/klntsky/omp-telegram-collab/commit/5c3d29bc3b0f5c2c7fb1d61a095624f869751bae)

Reject older managed-host preset controls that persist shared role settings and require retirement and restart before work-topic preset commands. Permit controls that change only the running session.

Reject startup or reload when any assigned session, including an attached session, is pinned to another configured project directory or its path no longer resolves to the same canonical directory. Validate managed bindings and histories against the session's pinned directory.

# [fa0953aca0f47c9fc8596983583425e1001f95c3](https://github.com/klntsky/omp-telegram-collab/commit/fa0953aca0f47c9fc8596983583425e1001f95c3)

Support only the current CLI-managed YAML and SQLite schema, without importing environment deployments or backfilling missing session paths. Initialize the current database tables transactionally and require a canonical pinned directory when assigning chats with saved histories.

# [9cc0f0c21a706ced87eb17176f0066349d4c0b44](https://github.com/klntsky/omp-telegram-collab/commit/9cc0f0c21a706ced87eb17176f0066349d4c0b44)

Forward the original Telegram task immediately below the pinned session entry and before host startup for both `/new task` and interactive initial-task replies. Preserve native forwarding and formatting instead of rewriting the task with participant attribution, without submitting it twice.

# [191c218cb7d33be6d303584671b7b0b1a42db6ff](https://github.com/klntsky/omp-telegram-collab/commit/191c218cb7d33be6d303584671b7b0b1a42db6ff)

Keep the ⚡ activity icon throughout an active agent turn, including idle streaming snapshots and tool work, until the turn ends or is interrupted.

# [e096c08020e314ecafc3e73b55efe565e11d2203](https://github.com/klntsky/omp-telegram-collab/commit/e096c08020e314ecafc3e73b55efe565e11d2203)

Automatically reconnect the Mini App after transient transport failures, authorization-service outages, welcome timeouts, and stalled snapshots. Obtain fresh single-use tickets, retain the current transcript and draft, and use exponential backoff from one second capped at 30 seconds. Do not queue or replay unsent or uncertain instructions.

Retain the original session generation during automatic reconnect. Stop automatic reconnect for killed sessions, denied or expired authentication, unavailable sessions, invalid protocol actions, capacity refusal, and explicit Leave. Require explicit Rejoin to adopt a killed session's current generation. Keep the reconnecting state until replacement history arrives.

Collapse recognized IRC, system-notice, reminder, notification, injection, interruption, and task-result envelopes and displayed custom notices into expandable transcript disclosures. Preserve ordinary prose, attachment order, code examples, unknown tags, and incomplete envelopes. Keep hidden custom entries hidden.

Clear running activity, active tools, aborting state, and queued-message state when a Mini App interruption is observed, and mark unfinished streamed output aborted. Derive participant avatar initials from the username without its `@`.

# [b45e7076d60acdb87047bc89e4c0de4373cca877](https://github.com/klntsky/omp-telegram-collab/commit/b45e7076d60acdb87047bc89e4c0de4373cca877)

Provide `/new <task>` to create a topic and submit its first task, and ask for the task when `/new` has no argument. Register manually created topics as sessions and start OMP on their first instruction or Mini App visit. Provide `/p <prompt>` for explicit-command prompts and create a new session topic when it is used in General. Provide `/session` for the current topic's Mini App link, `/status` for readiness, and `/help` for command help. Provide `/setup` to request enrollment or change an assigned forum's prompt settings.

Keep General separate from sessions. Restrict `/stop` and `/kill` to current group members in session topics, without starting idle hosts. Make `/stop` interrupt the current turn without terminating OMP, and make `/kill` force-terminate even a busy process, with possible loss of in-flight work. Both commands must cancel pending initial tasks, startup retries, and capacity confirmations.

Pin an Open Session message in new session topics before starting OMP. Return a topic link when `/new` or `/attach` creates a topic. Forward the original `/new` task below the pin without submitting it twice. Save topic renames as display-name changes. Closing a topic must archive instructions, and reopening must allow resumption. Preserve OMP history when topics are closed or deleted; do not rely on topic deletion as a cleanup signal.

Preserve history after `/kill` and invalidate existing Mini App connections, including automatic reconnects. Allow a later instruction, explicit Rejoin, or fresh Open Session visit to resume a managed session. Allow project admins to detach a topic permanently, disabling prompts, reactions, mirroring, approvals, and Mini App access while preserving history and leaving the host running. Use `/new` to create another session.

Default `all_messages_are_prompts` to `true` per bot/chat assignment so session-topic text becomes a prompt. When it is `false`, accept text only through `/p <prompt>`, including `/p@YourBot <prompt>`, without allowing mentions or replies to bypass the setting. Exclude other commands, forwarded messages, and bot messages from prompts.

Default `users_can_propose_prompts` to `false`, ignoring non-admin prompts while allowing admin prompts directly. When enabled, require project-admin approval for non-admin prompts, including `/new`. Show proposed text for review and execute it once after approval. Expire proposals after ten minutes or a service restart, and invalidate them after an assignment or prompt-mode change, topic archival, session kill, or proposer departure.

Identify project admins by the Telegram usernames configured for the directory and require current group membership. Telegram group-administrator status alone must not grant project-admin permissions; require it for enrollment of an unassigned group. Retain ordinary members' Mini App access and permission to use `/stop` and `/kill`, independently of prompt restrictions.

Mirror agent replies into Telegram with supported Markdown, literal model-provided HTML, and unlinked unsafe or relative links. Convert tables and images to text. Split long replies without breaking formatting or Unicode and retain their reply target. Mirror Mini App prompts with the sender's Telegram username, falling back to display name and numeric ID.

Show agent questions with their full text and numbered option buttons. Support custom multiline answers through Other and Telegram's reply prompt, sending them to the question rather than the prompt queue. Support cancellation. Close Telegram controls when the Mini App or terminal answers. Allow current group members to answer and let OMP resolve competing responses.

Use 👀 to acknowledge eligible input and 🤝 only after OMP confirms receipt, interruption for `/stop`, or process exit for `/kill`. Use ⚡ for a running turn including tool work, ✅ for a live idle host, and 🏁 for a stopped or not-yet-started host. Do not react to approval alone or failed or rejected instructions. Check liveness every 30 seconds and preserve confirmed icons across restarts, without treating relay disconnection as proof that OMP stopped. Respect Telegram permissions and rate limits for reactions and icons.

Queue Telegram delivery per chat with at least 3.1 seconds between scheduled operations. Prioritize questions and receipts over icon updates. Pause delivery for Telegram's `retry_after` on a 429 response. Do not automatically retry ambiguous network failures.

Provide project-admin commands to list model presets and the current selection, and to select a preset. In General, save the selection as the bot/chat default. Apply its models and thinking settings to new managed hosts before work, including resumed histories, overriding restored settings and model-selection flags without changing existing hosts. Fail startup if the saved preset is missing. In a session topic, start the host if needed and switch only that idle session without changing the default. Require attached hosts to switch through their local terminal and older managed hosts to restart if they cannot switch without changing shared settings.

Identify projects by canonical directory, allow multiple chats to share a project, and keep topic histories separate while sharing project working files. Removing a chat must disable access and mirroring without deleting history or killing hosts. Reject moving a chat with saved topics to another project. Run OMP with the service account's filesystem and credential access, without treating registrations or admin lists as process isolation.

Allow every authorized group member to control Mini App sessions regardless of Telegram prompt settings. Associate username-based admin permissions with the current owner of the configured handle. Validate signed Telegram Mini App data, age, session parameter, and current membership, with separate WebSocket checks. Keep OMP room keys and write tokens server-side and use opaque mapping IDs in links. Forwarded Mini App links must not grant membership. Require fresh membership checks for outbound batches without reusing a pending batch's check for later frames.

Advance a persistent session generation before kill notifications or termination. Reject old generations during ticket refresh, socket upgrade, host admission, and mirroring. Require explicit Rejoin to obtain the current generation after a kill. Treat separately shared OMP Collab links as capabilities outside Telegram membership revocation. Keep configuration and runtime data private and preserve history on service shutdown.

Limit resident managed OMP processes across all bots and projects through `maxSessions`, without counting saved conversations or empty topics. Permit retirement after five idle minutes and try least-recently-used idle hosts sooner when capacity is needed. Protect hosts with connected Mini Apps or pending or active work. Wait for OMP's guarded shutdown during retirement without escalating to signals or forcibly retiring unsupported older hosts. For `/kill`, verify process identity before SIGKILL and wait for exit.

When retirement cannot free capacity, allow a project admin to approve doubling the shared limit, save it, and retry the pending initial task once. Require other prompts to be resent and protected configuration to be updated through an administrator CLI operation. Reject expired or replayed capacity confirmations.

Mark initial tasks submitted before sending and retry only explicit startup rejection. Do not replay possibly executed instructions on disconnect; a crash between recording and sending may require the user to resend. Retry unexpected Telegram-mirroring disconnects up to five times with backoff, recovering unseen assistant entries rather than prompts. Post a notice after recovery fails and permit a later authorized prompt to reconnect. Retry Telegram polling network failures, rate limits, and server errors, but stop the service for invalid credentials or polling conflicts.

Retain the Mini App transcript and draft during transient failures. Reconnect with capped exponential backoff, a fresh single-use ticket, and renewed authentication and membership checks, without queuing or replaying instructions. Stop automatic reconnect after Leave, denied membership, expired launch credentials, invalid actions, or full capacity. Allow Rejoin when capacity returns and require reopening Open Session when Telegram credentials expire.

Allow project admins to attach control-shared OMP hosts whose working directory matches the assigned project. Preserve attached hosts across service shutdown. Require local restart and attachment of a replacement after an attached host is killed.

Collapse IRC traffic, system notices, reminders, task-result envelopes, and displayed custom notices in the Mini App, with disclosures to reveal them. Keep ordinary prose, attachments, code examples, unknown tags, and incomplete envelopes visible, while retaining hidden custom entries as hidden.

# [6e1cafbf5cd565953c65383c4ba53e5c93587314](https://github.com/klntsky/omp-telegram-collab/commit/6e1cafbf5cd565953c65383c4ba53e5c93587314)

Create topics with an initial task using the ⚡ icon immediately and retain it through host startup and initial-task admission. Start empty topics with stopped status.

# [efcc613c3b56f231bd5a20e66069718485650737](https://github.com/klntsky/omp-telegram-collab/commit/efcc613c3b56f231bd5a20e66069718485650737)

Recognize commands in message text and at the start of media captions even without Telegram command entities. Apply the same bot targeting, permissions, prompt settings, and handlers to caption commands as to text commands. Submit only caption text to OMP without downloading or sending attached media, and ignore non-command captions.

# [6b26ecafaa2ead9fb59fd07a8aa648f8b4fb08c3](https://github.com/klntsky/omp-telegram-collab/commit/6b26ecafaa2ead9fb59fd07a8aa648f8b4fb08c3)

Accept `/p`, including its bot-qualified form, in either prompt mode. When used as a reply, prepend the replied-to text or media caption with `> ` on every line, a blank line, and the supplied prompt. Submit just the quote for bare `/p` replying to text or a caption. Use the combined text as the initial task in General, retain authorization and proposal approval, and omit quoted context when the reply contains neither text nor a caption.

# [32c1aae406361fd6db77ada36ddb822b50bdc2b4](https://github.com/klntsky/omp-telegram-collab/commit/32c1aae406361fd6db77ada36ddb822b50bdc2b4)

Apply replied-to text and caption quoting to `/new`, including its bot-qualified form. Allow bare `/new` replying to text or a caption to submit just that quote as the new session's initial task.

# [81bb8fb85650a7804a739d1a978efe7835acc632](https://github.com/klntsky/omp-telegram-collab/commit/81bb8fb85650a7804a739d1a978efe7835acc632)

Send photos and JPEG, PNG, WebP, or GIF image documents to the model as image content with their prompt. Submit images with `/new` and `/p` caption instructions. In all-message mode, use session-topic image captions as prompts and use “Describe this image.” for captionless images. Ignore images without a prompt command in explicit-command mode. Use the largest photo size, preserve image-document bytes, handle messages individually rather than as albums, and require model image support.

When `/new` or `/p` creates a topic, forward any replied-to message below the pin and then the original task, including replied-to media without text or captions, without submitting the prompt twice. Do not forward the bot's task-request message for interactive task replies.

# [22623535639fa3f0b78613d73551826c9f84efa3](https://github.com/klntsky/omp-telegram-collab/commit/22623535639fa3f0b78613d73551826c9f84efa3)

Provide a project-admin-only `/terminate` command that persists `terminated: true`, force-kills every session host across bots, and leaves the bot online. While terminated, block commands, prompts, callbacks, and Mini App agent access. Reply to every command with “The service got terminated, only admin can resume it (remove terminated: true from the config)”. Cancel pending initial tasks and approvals while preserving histories. Require an operator with configuration access to remove the top-level flag to resume; restarting the bot must not clear termination.

Include session-topic images in the `all_messages_are_prompts` policy, with `/p` required to submit them when the setting is disabled.

Notify enrolled groups in General after successful startup with “OMP bot service is back online (restarting took N.NN seconds).” Measure the duration from the preceding orderly shutdown through readiness, including time between processes, or measure startup when no shutdown timestamp exists. Send a winding-down notice during orderly shutdown.

# [e2dfda28598e4d4c7634b6f211d7c91e8f0c2df8](https://github.com/klntsky/omp-telegram-collab/commit/e2dfda28598e4d4c7634b6f211d7c91e8f0c2df8)

# [a6c9dcb62af3cbdbfb6505137c688ae6cca299ea](https://github.com/klntsky/omp-telegram-collab/commit/a6c9dcb62af3cbdbfb6505137c688ae6cca299ea)

# [f6e4e369cb9bc2f03b9cec0f24d7f7819f4a752e](https://github.com/klntsky/omp-telegram-collab/commit/f6e4e369cb9bc2f03b9cec0f24d7f7819f4a752e)

# [4faf13beb5c1a0fae5679f8ee89ccd9b1020086f](https://github.com/klntsky/omp-telegram-collab/commit/4faf13beb5c1a0fae5679f8ee89ccd9b1020086f)

Accept non-command replies to this bot's messages as `/p` prompts in either mode, including image replies without prompt commands in explicit-command mode. Include the usual quoted context and, in General, create a session and forward the quoted message and user reply below its pin. Preserve authorization and proposal approval. Retain dedicated handling for interactive task-request replies and active or expired agent-question replies, and keep detached topics conversation-only. Continue ignoring ordinary discussion, mentions, and replies to other users or bots in explicit-command mode.

# [aaea54f9c2ab4d12e0942a92c8d82216e1baec61](https://github.com/klntsky/omp-telegram-collab/commit/aaea54f9c2ab4d12e0942a92c8d82216e1baec61)

Provide `/skills` to open a skill picker bound to the requesting user and source topic, including General. Make skill buttons work without inline mode, and offer inline search when enabled. Expire inline picker context after ten minutes without expiring pending selections, and allow reopening `/skills` to search again.

Accumulate pending skill selections separately per bot, chat, topic, and user and preserve them across service restarts. Confirm selection with “Your next message will mention /skill:name.” Provide `/skills clear` to clear the user's selection in the current topic. Do not submit a prompt merely by picking a skill.

Publish `/skill_<alias>` shortcuts for discovered skills. Lowercase names, replace runs outside ASCII letters, digits, and underscores with underscores, trim edge underscores, and limit complete commands to 32 characters. Give the first skill an alias collision without adding a hash suffix. Limit group menus to 100 commands including built-ins, retaining `/skills` for additional skills.

Preserve canonical skill names' exact case, punctuation, and namespaces. Report names containing whitespace, control characters, or backslashes as unsupported in the picker. Validate managed-session skills against the live loaded catalog and require restart for older managed hosts lacking skill-lifecycle support. Discover attached-host skills using assigned instance settings without inspecting terminal-private loaded skills. Do not automatically reload OMP when catalog changes are discovered.

Prefix the next accepted prompt with space-separated selected `/skill:name` references, a blank line, and the normalized prompt including any reply quote. Preserve image and quoting behavior and treat the mentions as prompt text rather than native skill-template expansion.

Submit image albums as one prompt with all supported images, captions in message order, and one pending-skill selection. Apply single-image General and topic routing to album command captions. Forward the quoted source and every album message when creating a topic.

Consume pending skills when a prompt is accepted or a non-admin proposal is created. Freeze proposal text for review and approval without restoring selections on rejection or expiry. Retain selections for input ignored or rejected before submission, and restore them after known host-starting rejection. Do not restore selections after ambiguous delivery errors. Carry the originating user's General selection into a new session's initial task and consume it on durable acceptance or proposal creation.

# [37a08433fe6586e367de77d1c794f2772b5340bc](https://github.com/klntsky/omp-telegram-collab/commit/37a08433fe6586e367de77d1c794f2772b5340bc)

Provide `/set_default_new_topic_skill <exact-skill-name>` in General and session topics to set the bot/chat forum default without changing the current session. Restrict it to instance admins who are current group members. Validate exact canonical names against the assigned project catalog and reject whitespace, control characters, or backslashes while preserving case, punctuation, and namespaces. With no argument, display the default. Use `--clear` to remove it, while treating bare `clear` as a literal catalog skill name.

Snapshot the default into future managed topics and preserve the snapshot across restarts. Add it only to the first accepted Telegram prompt or frozen proposal, deduplicated with explicit selections. Include it in General `/p` and `/new` initial tasks and freeze it into proposals. Allow any authorized user's first Telegram task in a manually created topic to use the snapshot. Keep existing topics, snapshots, and attached histories unchanged after later default changes. Mini App submissions must neither apply nor consume this default.

# [ac60a8d5928686d95c36382171d04b02755f35bd](https://github.com/klntsky/omp-telegram-collab/commit/ac60a8d5928686d95c36382171d04b02755f35bd)

Provide project-admin-only `/unset_default_new_topic_skill` to remove the forum default for future topics, accepting no arguments. Give the set command no clearing argument and retain `clear` as an ordinary exact skill name.

# [b2e90e665f164fe5756aec6e3ee47ad9c7168afc](https://github.com/klntsky/omp-telegram-collab/commit/b2e90e665f164fe5756aec6e3ee47ad9c7168afc)

Keep skill-picker replies and confirmations in their source topic. Omit Telegram's message-thread parameter for General replies rather than sending its internal selection key as a thread ID.

# [939491cd53810b6b361bf5541fca7c9c305c76f1](https://github.com/klntsky/omp-telegram-collab/commit/939491cd53810b6b361bf5541fca7c9c305c76f1)

# [c3364123482ee552c5964b1c7abea89f144c2777](https://github.com/klntsky/omp-telegram-collab/commit/c3364123482ee552c5964b1c7abea89f144c2777)

Keep bot messages and new-topic links in their intended destination as well as skill-picker confirmations. Do not route General messages to an ordinary forum thread, and retain session messages in their session topic.

# [8bf92198d152e49f965a0f7f5ec56c2164d8154d](https://github.com/klntsky/omp-telegram-collab/commit/8bf92198d152e49f965a0f7f5ec56c2164d8154d)

Queue a skill for the next prompt when its shortcut is bare. When a shortcut includes task text, submit immediately with its canonical mention, pending selections, and applicable new-topic default, deduplicated. Follow `/p` routing in either prompt mode, creating a new session topic from General and using the current session elsewhere. Preserve reply quotes, supported images and albums, bot-qualified commands, authorization, and proposal approval. Do not queue the immediate skill for a later prompt when submission is ignored or rejected.

# [b46711a48d30053052539ccf47cb328c949e9a14](https://github.com/klntsky/omp-telegram-collab/commit/b46711a48d30053052539ccf47cb328c949e9a14)

Distinguish instance roots, bot-wide admins, and topic admins. Allow instance roots and bot admins to submit new-session and existing-topic prompts directly. Restrict topic admins' direct prompts and proposal approvals to their own existing topic; apply the ordinary proposal policy to their new-session requests. Require instance-root or bot-admin authority for attaching hosts, forum settings, default new-topic skills, capacity increases, and service termination. Allow topic admins to detach their own topic, list its presets, and switch its idle session preset, while restricting General preset defaults to instance roots and bot admins.

Treat Telegram's implicit reply to a topic-creation message as routing metadata rather than an intentional reply to the bot. Ignore ordinary messages carrying it when all-message prompts are disabled, including in topics created by this bot.

Provide `/make_admin @username` and `/make_admin username` to promote by username, and argument-free `/make_admin` as a reply to promote by stable numeric Telegram ID. Reject numeric-ID arguments. Normalize handles by removing an optional `@` and lowercasing according to the configured username grammar. Do not look up arbitrary handles during promotion; require active human membership when the recipient exercises permissions. Require reply targets and callers to be active human group members and reject bot, departed-member, anonymous, and channel reply targets.

Grant bot-wide access across that bot's assigned chats when promotion occurs in General, and topic-only access in other topics. Permit instance roots and bot admins to promote in either scope and topic admins to promote only within their own topic. Keep grants separate from Telegram administrator roles and other bots. Retain Telegram group-administrator status as an enrollment requirement rather than application-admin authority.

Persist bot-wide grants in configuration and topic grants in the runtime database across restarts, using normalized username strings or numeric IDs from replies. Keep username grants attached to the current handle owner and reply grants attached to the user ID through username changes. Preserve existing instance username roots. Revoke bot-wide grants locally through configuration and topic grants through the database rather than a Telegram demotion command.

Provide argument-free `/list_admins` to every active human member of the assigned forum. Show separate global and topic sections, combining instance roots and the current bot's grants in the global section. Include all this bot/chat's topic grants in General and only the current topic's grants elsewhere. Exclude other chats and bots and omit topic entries already represented globally by normalized username or numeric-ID aliases. Display a numeric grant's current username when membership lookup supplies it and otherwise display `User ID: <id>`. Keep roster display separate from proof of membership or verified handle ownership and require current human membership whenever permissions are exercised.
