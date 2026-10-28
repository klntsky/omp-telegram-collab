# Engineering principles

- No error message muting. Preserve the exact original error message when propagating or reporting a failure; never replace it with a generic summary. Add context without removing or rewriting the original diagnostic. Propagate the original error object where possible so subprocess exit codes, signals, and other diagnostic fields remain available. User-facing failure reports must retain the original message, including multiline diagnostics.
- Commit as soon as you complete a feature, then restart the bot.
- Always register new or renamed Telegram slash commands in the appropriate Telegram command menus; handlers and `/help` text alone are not sufficient. Keep menu entries synchronized with command availability and retain server-side authorization checks for admin-only commands.
- This project is unpublished. Keep a single current schema and configuration format; collapse migrations and remove legacy compatibility paths rather than retaining shims or automatic imports.
- Keep test fixtures isolated per case. Prefer in-memory SQLite unless the scenario verifies disk persistence or restart behavior, and run test files with concurrency five.
- Use straightforward numbered lists starting at 1 in user-facing responses. Use 1.1, 1.2, and similar numbering when grouping is necessary.
