# Architecture

This document describes ownership and boundaries. User-visible requirements belong in [Product](PRODUCT.md). Setup and operational commands belong in [Development](DEVELOPMENT.md).

## Service composition

The CLI owns configuration management and starts the service. The running service composes Telegram bot adapters, persistent session storage, the OMP runtime manager, and the HTTP and WebSocket gateway. Bot adapters and the gateway share the runtime and session store, so Telegram and Mini App clients reach the same OMP conversation rather than maintaining independent agent state.

Configuration is the authority for project directories, bot identities, chat assignments, instance roots, bot-wide admins, and service settings. Runtime storage holds scoped topic grants but cannot override those configured assignments or roots. The service coordinates reloads so components apply a validated configuration while managed host processes and histories remain independently recoverable.

The service owns the readiness boundary: mandatory runtime and history checks, initialized bot identities and cached menus, bound HTTP listener, and a successful first poll for every bot. Only after that boundary does it start adapter maintenance and the separately tracked online notification. Notification delivery is not a readiness dependency. Shutdown cancels the online task, drains input with update acknowledgements intact, and closes component-owned work before storage.

Each adapter owns a cancellable background task set for session restoration, status maintenance, reconnects, and catalog refreshes. Readiness initialization does not start those lifecycles. Shutdown cancels waits and scheduled retries, fences late results from storage and Telegram side effects, and drains publication and delivery work. Runtime-owned discovery processes outlive an individual consumer only while another consumer still needs them.

The bot adapter enforces application-admin scope independently of Telegram group roles. Configuration owns instance roots and bot-wide grants; SQLite owns topic-local grants across restarts. Promotion rechecks current human membership and assignment authority before writing through the owning persistence boundary. Topic authority cannot grant access outside its topic. See [Product](PRODUCT.md#12-prompts-and-permissions) for command behavior.

Admin listings share the current-member authorization boundary. The adapter combines configured global authority with topic grants from storage, limits the result to the current forum or topic, and reconciles stored identities for display. Listing a stored grant does not establish the recipient's current membership; access-use checks remain authoritative.

The configuration layer owns the persistent service-termination switch. Telegram dispatch, gateway access and frame forwarding, and runtime admission recheck that switch at their respective boundaries, preventing a client or reconnect from bypassing suspension. Bot adapters invalidate pending interactions and invoke the runtime's identity-checked kill boundary; the service and Telegram polling stay alive.

## Telegram integration

Each bot adapter owns Telegram command handling, membership checks, prompt proposals, interactive questions, and transcript mirroring for its bot. It translates authorized user actions into runtime and Collab operations. It does not own OMP's conversation history or execute model turns itself.

grammY owns Telegram contexts and API transport. The bot adapter retains polling readiness, input ordering, cancellation, and shutdown acknowledgements rather than delegating those guarantees to framework-managed polling. The administration CLI uses grammY's API client without starting a poller.

The adapter owns process-local diagnostic observations for each session and project catalog. Prompt writes establish an unconfirmed observation; matching Collab receipts establish admission, not successful completion. Disconnect invalidates unconfirmed admission without inferring host exit. Runtime inspection remains read-only and reports failures as unknown state. Status reads those observations and the persisted catalog without invoking execution or recovery.

The status authorization boundary retains current-human membership, enrollment and assignment checks while allowing inspection during service suspension or degraded bot permissions. It rechecks membership and assignment before delivering diagnostic chunks and exposes only the current topic's session and assigned project's catalog. The normal action-authorization boundary remains unchanged and continues to enforce termination and bot permissions.

Interactive question answers cross the Collab UI-response boundary, not the prompt-submission boundary. Pending requests remain bound to their source destination and host lifecycle. Telegram delivery or a local button click is not evidence of host acceptance: completion receipts depend on the corresponding Collab confirmation, while force-termination completion depends on the runtime verifying process exit.

Topic destinations distinguish General from ordinary forum topics before business logic or storage access. The inbound Telegram boundary parses message and callback destinations; callers pass that identity rather than a database key. Storage alone encodes destinations into durable lookup keys. The outbound message adapter owns Telegram chat and thread routing for replies, sends, forwards, and service notices; its options exclude routing fields so callers cannot override the destination. Topic-management operations remain separate and require an actual session topic.

The bot adapter normalizes text and media captions before command dispatch. After prompt authorization, it resolves Telegram image files and attaches their bytes to the existing Collab prompt. Approval and initial-task admission own the entire prompt, including images; the session store preserves initial images with their task so recovery does not degrade to text-only delivery.

The inbound bot adapter distinguishes intentional replies from Telegram's implicit reply to a forum topic's creation message. Topic-root metadata establishes routing context, not user intent, even when the bot created the topic. This classification happens before reply-to-prompt conversion so metadata cannot bypass the configured prompt mode. The runtime receives only prompts admitted by that boundary.

The adapter groups image-album updates before prompt dispatch and keeps their place in the input queue, so a subsequent skill selection cannot alter an earlier album. The resulting prompt uses the same authorization, proposal, and image-admission boundaries as single-message input.

The bot adapter owns the user/topic-bound skill picker and its temporary inline-search context. It composes selected `/skill:name` references into authorized prompt text without implementing native skill-template expansion. Prompt admission and proposal creation own consumption of the pending selection; proposals retain the composed text independently of later picker changes.

The bot adapter owns the instance-root and bot-admin controls that set and unset the per-bot/chat forum skill default; topic grants do not authorize these forum-wide settings. The configuration boundary validates canonical mentionable names without normalization; the adapter additionally checks catalog existence and current administrator membership before saving.

The delivery queue owns scheduling of Telegram output and rate-limit delays. Transcript rendering converts agent output into Telegram-supported formatting before delivery. Keeping delivery separate from session execution prevents Telegram scheduling from becoming the authority for whether OMP accepted a task.

The bot adapter owns topic activity projection. Collab host snapshots reconcile lifecycle-event observations; the runtime's process-liveness boundary distinguishes an idle host from a stopped one. The delivery queue owns only when that projection reaches Telegram, not the underlying activity state.

## OMP execution and lifecycle

The runtime manager owns host discovery, startup, attachment, capacity, activity tracking, and process identity checks. Managed hosts run interactive OMP in PTYs under detached supervisors. The supervisor boundary lets hosts outlive a service process and lets the next service recover them. Attached hosts remain owned by their original terminal.

The runtime boundary owns skill-catalog discovery from OMP for the project and, when applicable, its session host. Bot adapters consume catalog names and descriptions through that boundary rather than inspecting OMP resources themselves.

The runtime owns per-instance catalog caching, shared in-flight discovery, and failure cooldowns. Managed sessions remain authoritative for their live loaded catalog; older managed hosts without skill-lifecycle support reject discovery with a restart instruction rather than approximate their catalog. Attached-host discovery uses assigned instance settings and cannot inspect terminal-private loaded skills. Discovery neither reloads OMP nor automatically restarts active hosts. Bot adapters own canonical-name eligibility, Telegram-safe skill aliases, and group-scoped command-menu publication. The service scheduler requests menu refreshes; adapters publish only changed menus. Refresh failures preserve original diagnostics and existing menus without blocking bot startup; new groups retain built-in commands.

The store owns durable snapshots of the last successful project catalog. Discovery runs independently per instance and yields snapshots; only menu publication is serialized. Publication rechecks current assignments before installing aliases, and failed discovery leaves the prior snapshot intact. Configuration reconciliation cancels obsolete catalog work and removes unauthorized listeners before publishing current cached menus; fresh discovery and restoration cannot hold up the configuration acknowledgement. Single-flight initialization installs identity and cached menus once, independently of maintenance.

OMP owns agent execution, conversation history, interactive questions, and live Collab state. The service connects as a Collab guest. It does not reconstruct an independent conversation from Telegram messages. Shared contracts describe communication between the service components and clients; they do not move execution authority into the browser.

Model-preset operations use a private host-control socket rather than model prompts. OMP owns native preset diagnostics and role precedence; managed-host controls must apply changes only to the session, never persist them into shared OMP role settings. Unsupported older or attached hosts cannot substitute a configuration-writing control path.

The runtime uses OMP's guarded lifecycle boundary for idle retirement. Explicit force termination has a different boundary: the runtime must verify the intended process identity before signaling it. A database lock excludes another service from managing the same runtime data concurrently.

The lifecycle extension instance that creates a host's control server owns its descriptor and socket cleanup. Subagent and unstarted extension instances have no authority to remove the main host's control metadata.

## Durable and temporary state

The configuration layer owns validated, atomic updates to the protected YAML file. The session store owns durable Telegram topic mappings, enrollment state, session generations, recorded session metadata, and pending skill selections scoped by bot, chat, topic, and user. Pending selections survive service restarts and outlive the adapter's ten-minute inline picker context. OMP owns history files. Runtime bindings connect a Telegram session to its verified OMP identity and history rather than selecting whichever host happens to occupy a process identifier.

New managed-topic creation snapshots the forum skill default into durable session state, independent of the creator and surviving bot restarts. Telegram prompt admission applies the snapshot only to the first accepted Telegram prompt or proposal and deduplicates it against explicit pending selections. General `/p` and `/new` compose it into their initial task before proposal freezing; manual topics use the first authorized user's accepted Telegram task. Later configuration changes do not rewrite existing topic snapshots or attached histories. The Mini App submission boundary does not apply or consume this Telegram composition state.

Bot adapters own temporary proposals and pending Telegram interactions. The gateway owns temporary connection tickets. The browser owns its local draft and rendered transcript. None of those temporary states can replace durable authorization or process identity.

## Gateway and browser

The HTTP gateway serves the Mini App and authenticates Telegram launch data. Its ticket boundary authorizes entry to the WebSocket transport. The WebSocket gateway separately checks session authorization and mediates Collab frames; loading the page alone does not grant host access.

The gateway keeps upstream room credentials on the server. It checks current group membership and configuration assignments before admitting access and before forwarding output batches. Session generations connect persisted invalidation to ticket issuance, connection upgrades, and host admission. Rechecking after asynchronous authorization prevents an earlier decision from authorizing a session that changed while the request was pending.

The bot adapter owns the shared application-admin predicates and evaluates Mini App control using freshly fetched Telegram membership and the stored session destination. The gateway independently admits each queued mutation using that current result, session lifecycle checks, and the raw host read-only restriction before any execution side effect. Its explicit action allowlist defaults to denial. Identity tickets carry no durable administrator capability. Browser read-only state and reconnects project authority for presentation only; neither is trusted to enforce it. Observed role changes on output reconnect the client without granting stale actions, and local session/assignment/generation checks are repeated across asynchronous admission boundaries.

The Mini App owns presentation and client reconnection. It requests fresh authorization through the gateway rather than holding upstream host capabilities. Its transcript and draft are presentation state, not evidence that an instruction executed. The transport must not turn a reconnect into prompt replay.

## Trust boundaries

Telegram's signature establishes the caller's numeric identity and launch context. Current membership and configured usernames determine the permissions enforced by the bot and gateway. Those checks protect access through this service; they cannot revoke an independently distributed OMP Collab capability.

The operating-system account is the filesystem and credential boundary. Project directories, chat assignments, and admin lists organize access inside the application but do not sandbox OMP processes. Isolation between mutually untrusted users requires an account or container boundary outside the application.

The reverse proxy provides public HTTPS and forwards upgraded connections to the local service. Bot tokens and runtime data stay in protected server-side storage. The browser receives session access through the gateway, not direct ownership of the host's credentials.
