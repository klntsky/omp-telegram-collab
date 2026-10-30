# OMP Telegram Collab

Use [OMP](https://github.com/can1357/oh-my-pi) from Telegram while it runs on your own machine. Each forum topic is a separate coding conversation with saved history. Continue the same session in Telegram, the Mini App, or your local OMP terminal.

![Coding conversations in Telegram forum topics](assets/telegram-topics.jpg)

Send prompts and images in a topic, read the agent's replies, and answer its questions with buttons. Open the Mini App to see tool calls, follow subagents, or send them messages.

You can start a new session, attach one already running locally, or move a conversation into a Git worktree. Groups can share project directories, with configurable approval for prompts.

## Getting started

You'll need OMP installed on your machine and a Telegram group with forum topics enabled. Follow the [setup guide](DEVELOPMENT.md) to connect the bot.

Once connected, use `/new <task>` to start a conversation or `/attach INSTANCE_ID` to connect a running local session. Open `/session` in a topic for the Mini App.

OMP still runs tools on your machine. Telegram and the Mini App provide remote access, not every command available in the terminal.

## More information

- [User guide](PRODUCT.md) for controls, session behavior, and permissions.
- [Development guide](DEVELOPMENT.md) for setup, configuration, and deployment.
- [Architecture](ARCHITECTURE.md) for how the components fit together.
