# Architecture

This document describes ownership and boundaries. User-visible requirements belong in [Product](PRODUCT.md). Setup and operational commands belong in [Development](DEVELOPMENT.md).

## Service composition

The CLI owns configuration management and starts the service. The running service composes Telegram bot adapters, persistent session storage, the OMP runtime manager, and the HTTP and WebSocket gateway. Bot adapters and the gateway share the runtime and session store, so Telegram and Mini App clients reach the same OMP conversation rather than maintaining independent agent state.

Configuration is the authority for project directories, bot identities, chat assignments, admins, and service settings. Runtime storage cannot create authorization by overriding configuration. The service coordinates reloads so components apply a validated configuration while managed host processes and histories remain independently recoverable.

The configuration layer owns the persistent service-termination switch. Telegram dispatch, gateway access and frame forwarding, and runtime admission recheck that switch at their respective boundaries, preventing a client or reconnect from bypassing suspension. Bot adapters invalidate pending interactions and invoke the runtime's identity-checked kill boundary; the service and Telegram polling stay alive.

## Telegram integration

Each bot adapter owns Telegram command handling, membership checks, prompt proposals, interactive questions, and transcript mirroring for its bot. It translates authorized user actions into runtime and Collab operations. It does not own OMP's conversation history or execute model turns itself.

The bot adapter normalizes text and media captions before command dispatch. After prompt authorization, it resolves Telegram image files and attaches their bytes to the existing Collab prompt. Approval and initial-task admission own the entire prompt, including images; the session store preserves initial images with their task so recovery does not degrade to text-only delivery.

The adapter groups image-album updates before prompt dispatch and keeps their place in the input queue, so a subsequent skill selection cannot alter an earlier album. The resulting prompt uses the same authorization, proposal, and image-admission boundaries as single-message input.

The bot adapter owns the user/topic-bound skill picker and its temporary inline-search context. It composes selected `/skill:name` references into authorized prompt text without implementing native skill-template expansion. Prompt admission and proposal creation own consumption of the pending selection; proposals retain the composed text independently of later picker changes.

The adapter's instance-admin-only `/set_default_new_topic_skill` control updates the per-bot/chat forum default from General or session topics. The configuration boundary validates `default_new_topic_skill` with the shared canonical mentionable-name predicate, preserving exact names; the adapter additionally checks catalog existence. No argument reads the setting and `--clear` removes it; bare `clear` remains an exact skill name.

The delivery queue owns scheduling of Telegram output and rate-limit delays. Transcript rendering converts agent output into Telegram-supported formatting before delivery. Keeping delivery separate from session execution prevents Telegram scheduling from becoming the authority for whether OMP accepted a task.

## OMP execution and lifecycle

The runtime manager owns host discovery, startup, attachment, capacity, activity tracking, and process identity checks. Managed hosts run interactive OMP in PTYs under detached supervisors. The supervisor boundary lets hosts outlive a service process and lets the next service recover them. Attached hosts remain owned by their original terminal.

The runtime boundary owns skill-catalog discovery from OMP for the project and, when applicable, its session host. Bot adapters consume catalog names and descriptions through that boundary rather than inspecting OMP resources themselves.

The runtime owns per-instance catalog caching, shared in-flight discovery, and failure cooldowns. Managed sessions remain authoritative for their live loaded catalog; older managed hosts without skill-lifecycle support reject discovery with a restart instruction rather than approximate their catalog. Attached-host discovery uses assigned instance settings and cannot inspect terminal-private loaded skills. Discovery neither reloads OMP nor automatically restarts active hosts. Bot adapters own canonical-name eligibility, Telegram-safe skill aliases, and group-scoped command-menu publication. The service scheduler requests menu refreshes; adapters publish only changed menus. Refresh failures preserve original diagnostics and existing menus without blocking bot startup; new groups retain built-in commands.

OMP owns agent execution, conversation history, interactive questions, and live Collab state. The service connects as a Collab guest. It does not reconstruct an independent conversation from Telegram messages. Shared contracts describe communication between the service components and clients; they do not move execution authority into the browser.

The runtime uses OMP's guarded lifecycle boundary for idle retirement. Explicit force termination has a different boundary: the runtime must verify the intended process identity before signaling it. A database lock excludes another service from managing the same runtime data concurrently.

## Durable and temporary state

The configuration layer owns validated, atomic updates to the protected YAML file. The session store owns durable Telegram topic mappings, enrollment state, session generations, recorded session metadata, and pending skill selections scoped by bot, chat, topic, and user. Pending selections survive service restarts and outlive the adapter's ten-minute inline picker context. OMP owns history files. Runtime bindings connect a Telegram session to its verified OMP identity and history rather than selecting whichever host happens to occupy a process identifier.

New managed-topic creation snapshots the forum skill default into durable session state, independent of the creator and surviving bot restarts. Telegram prompt admission applies the snapshot only to the first accepted Telegram prompt or proposal and deduplicates it against explicit pending selections. General `/p` and `/new` compose it into their initial task before proposal freezing; manual topics use the first authorized user's accepted Telegram task. Later configuration changes do not rewrite existing topic snapshots or attached histories. The Mini App submission boundary does not apply or consume this Telegram composition state.

Bot adapters own temporary proposals and pending Telegram interactions. The gateway owns temporary connection tickets. The browser owns its local draft and rendered transcript. None of those temporary states can replace durable authorization or process identity.

## Gateway and browser

The HTTP gateway serves the Mini App and authenticates Telegram launch data. Its ticket boundary authorizes entry to the WebSocket transport. The WebSocket gateway separately checks session authorization and mediates Collab frames; loading the page alone does not grant host access.

The gateway keeps upstream room credentials on the server. It checks current group membership and configuration assignments before admitting access and before forwarding output batches. Session generations connect persisted invalidation to ticket issuance, connection upgrades, and host admission. Rechecking after asynchronous authorization prevents an earlier decision from authorizing a session that changed while the request was pending.

The Mini App owns presentation and client reconnection. It requests fresh authorization through the gateway rather than holding upstream host capabilities. Its transcript and draft are presentation state, not evidence that an instruction executed. The transport must not turn a reconnect into prompt replay.

## Trust boundaries

Telegram's signature establishes the caller's numeric identity and launch context. Current membership and configured usernames determine the permissions enforced by the bot and gateway. Those checks protect access through this service; they cannot revoke an independently distributed OMP Collab capability.

The operating-system account is the filesystem and credential boundary. Project directories, chat assignments, and admin lists organize access inside the application but do not sandbox OMP processes. Isolation between mutually untrusted users requires an account or container boundary outside the application.

The reverse proxy provides public HTTPS and forwards upgraded connections to the local service. Bot tokens and runtime data stay in protected server-side storage. The browser receives session access through the gateway, not direct ownership of the host's credentials.
