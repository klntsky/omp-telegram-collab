# Changelog

## Unreleased

- Replace JSON service configuration and the initialization wizard with environment variables and automatic `.env` loading in the pnpm startup commands.
- Add a blank environment template for required bot credentials, owner usernames, the public URL, and optional runtime settings.
- Identify owners by case-insensitive Telegram usernames. Enrollment and attachment verify the caller's current username and administrator status.
- Preserve multiple bots through named environment prefixes and literal OMP arguments through numbered variables.
- Add environment parsing, CLI loading and precedence, username transfer, stale identity, and owner authorization regressions.

## 0.1.0

- Add a TypeScript service with pnpm and Telegraf for user-owned Telegram bots and forum groups.
- Persist bot, group, and topic session mappings in SQLite.
- Manage real local OMP Collab hosts under PTYs and attach existing control hosts without taking over their lifecycle.
- Pin managed session IDs and exact history files across restarts. Prevent concurrent writers to the same runtime data directory.
- Add owner/admin onboarding, readiness checks, `/new`, `/attach`, mention/reply routing, topic lifecycle synchronization, and chunked agent responses.
- Fork the OMP Collab Web renderer and its matching browser Markdown utilities as editable source with upstream MIT attribution.
- Authenticate Mini App launches with signed Telegram data, current group membership, one-use WebSocket tickets, and server-owned Collab capabilities.
- Add cancellation-safe polling, explicit prompt-rejection notices, bounded mirroring reconnection, and recovery of unseen transcript entries without replaying prompts.
- Add authorization, persistence, polling lifecycle, anonymous-admin archive, and concurrent-participant regressions, plus a repeatable local protocol and runtime smoke command.
