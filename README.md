# OMP Telegram Collab

Run [OMP](https://github.com/can1357/oh-my-pi) coding sessions from Telegram forum topics on your own machine. Telegram, the Mini App, and the local OMP terminal connect to the same session.

![OMP Telegram Collab conversations organized into Telegram forum topics](assets/telegram-topics.jpg)

- Give each topic its own conversation and saved history.
- Send prompts and answer agent questions in Telegram or the Mini App.
- Attach existing local OMP sessions.
- Share project directories across groups with configurable prompt approval.
- Edit the included Collab Web client without an iframe.

## Telegram commands

| Command | What it does |
| --- | --- |
| `/new <task>` | Create a topic and start a task. |
| `/worktree [task]` | Create a topic and session in a separate Git worktree. |
| `/p <prompt>` | Send a prompt, or create a topic when used in General. |
| `/skills` | Pick skills for your next prompt. Use `/skills clear` to clear the selection. |
| `/session` | Open the current topic's session in the Mini App. |
| `/stop` | Interrupt the current turn without stopping OMP. |
| `/kill` | Force-kill the topic's OMP process. In-flight work may be lost. |
| `/attach INSTANCE_ID` | Connect a running local OMP host to a new topic. |
| `/detach` | Make the topic permanently conversation-only. |
| `/model_preset <name>` | Set the forum default in General, or switch an idle topic's model preset. |
| `/list_model_presets` | List model presets and the current selection. |
| `/set_default_new_topic_skill <name>` | Set the default skill for future topics. Omit the name to show it. |
| `/unset_default_new_topic_skill` | Remove the default skill for future topics. |
| `/setup` | Request forum enrollment or change prompt settings. |
| `/make_admin [@username]` | Grant topic admin access, or bot-wide access in General. Reply to a user to omit the username. |
| `/list_admins` | List global admins and topic admins. |
| `/status` | Show session, host, and service diagnostics. |
| `/terminate` | Kill all session hosts across bots and suspend the service until an operator resumes it. |
| `/help` | Show commands and prompt settings. |
| `/start` | Show bot setup and command guidance. |

Admin permissions depend on the command and topic. See [command behavior and permissions](PRODUCT.md#11-sessions-and-commands) for details.

## Documentation

- [Product](PRODUCT.md): session behavior, permissions, and user controls.
- [Development](DEVELOPMENT.md): setup, configuration, testing, and deployment.
- [Architecture](ARCHITECTURE.md): component ownership and process and trust boundaries.
