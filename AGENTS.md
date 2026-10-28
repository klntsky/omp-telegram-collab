# Engineering principles

- No error message muting. Preserve the exact original error message when propagating or reporting a failure; never replace it with a generic summary. Add context without removing or rewriting the original diagnostic. Propagate the original error object where possible so subprocess exit codes, signals, and other diagnostic fields remain available. User-facing failure reports must retain the original message, including multiline diagnostics.
- Commit as soon as you complete a feature, then restart the bot.
- Always register new or renamed Telegram slash commands in the appropriate Telegram command menus; handlers and `/help` text alone are not sufficient. Keep menu entries synchronized with command availability and retain server-side authorization checks for admin-only commands.
