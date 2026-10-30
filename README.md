# OMP Telegram Collab

Run [OMP](https://github.com/can1357/oh-my-pi) coding sessions from Telegram forum topics on your own machine. Telegram, the Mini App, and the local OMP terminal connect to the same session.

![OMP Telegram Collab conversations organized into Telegram forum topics](assets/telegram-topics.jpg)

- Give each topic its own conversation and saved history.
- Send prompts and answer agent questions in Telegram or the Mini App.
- Attach existing local OMP sessions.
- Share project directories across groups with configurable prompt approval.
- Edit the included Collab Web client without an iframe.

## OMP feature coverage

✅ Available in Telegram · 📱 Mini-app only · ⚠️ Partial support · ❌ No remote equivalent.

| Support level | OMP feature | Use from Telegram |
| --- | --- | --- |
| ✅ | Create a session (`/new`) | `/new <task>` creates a topic and starts its session. |
| ✅ | Open a topic's session (`/session`) | `/session` returns its Mini App link. |
| ✅ | Resume the current topic's managed history (`/resume`) | Send a prompt in the existing topic, or open `/session`. |
| ❌ | Pick another saved session or pin it (`/resume`, `/pin`, `/session`) | No saved-session picker, pin control, or general session-management interface. |
| ❌ | Rename or relocate a session's workspace (`/rename`, `/move`, `/add-dir`, `/remove-dir`, `/dirs`) | No dedicated title or workspace controls. |
| ❌ | Branch, rewind, fork, or switch history branches (`/branch`, `/rewind`, `/fork`, `/tree`) | No history mutation controls. |
| ❌ | Reset context, delete a session, refresh provider state, or retry a failed turn (`/clear`, `/delete`, `/fresh`, `/retry`) | No equivalent controls. |
| ✅ | Move a session into a worktree (`/wt`, `/worktree`) | `/worktree [branch]` invokes OMP's native operation, keeping the topic's conversation and carrying changes according to OMP's settings. In General, it creates a topic first. |
| ✅ | Attach a running local host (`/collab`, `omp collab`) | `/attach INSTANCE_ID` creates a topic connected to that host. |
| 📱 | Leave or rejoin the topic's live connection (`/leave`, `/join`) | Open `/session`, then use Leave or Rejoin. This does not terminate the host. |
| ❌ | Create arbitrary Collab share links or join arbitrary rooms (`/collab`, `/join`, `omp collab`, `omp join`) | No remote link-creation or arbitrary-room interface. |
| ✅ | Submit text prompts | `/p <prompt>`, ordinary messages when enabled, or the Mini App composer. Mini App prompts also appear in the topic. |
| ✅ | Submit image prompts | Send photos or supported image documents in Telegram, with `/p` when required by prompt policy. The Mini App composer has no upload control. |
| ✅ | Answer agent questions | Use Telegram option buttons, Other, or Cancel; the Mini App also offers option buttons, a text editor, and Cancel. Mini App answers require control permission. |
| ✅ | Interrupt the current turn | `/stop` or the Mini App Stop button. This does not freeze all agents. |
| ✅ | Force-kill a session host | `/kill` preserves managed history; a later prompt can resume it. |
| ❌ | Orderly exit or same-flags restart (`/exit`, `/quit`, `/q`, `/restart`) | `/kill` is forceful termination, not these lifecycle operations. |
| ✅ | Read agent replies | Replies are mirrored into the topic and streamed in the Mini App. |
| 📱 | Inspect the full live transcript and tool calls | Open `/session` to inspect tool arguments, results, partial output, and expandable tool details. |
| 📱 | Inspect thinking and message metadata | Expand disclosures in the Mini App transcript. |
| 📱 | Inspect subagent roster and activity (`/hub`, `/subagents`, `/agents`) | Open the Mini App agent rail to see status, current tool or intent, and last activity. |
| 📱 | Read a subagent's transcript (`/hub`, `/subagents`) | Select an agent to open its drawer. Transcript access requires an available session file. Viewers can read it too. |
| 📱 | Chat with a subagent (`/hub`, `/subagents`) | Send a message from its Mini App drawer. Requires control permission and a live connection. |
| 📱 | Kill a running subagent (`/hub`, `/subagents`) | Use Kill in its Mini App drawer. Requires control permission. |
| 📱 | Revive a parked or aborted subagent (`/hub`, `/subagents`) | Use Revive in its Mini App drawer. Requires control permission. |
| 📱 | Inspect subagent model and usage (`/hub`, `/subagents`) | The agent rail and drawer show model, tokens, cost, tool count, and duration when the host supplies them. |
| ❌ | Configure per-agent models, prewalk, or advisor (`/agents`) | No corresponding Mini App or bot controls. |
| ✅ | List, switch, and edit model presets (`/modelpreset`) | `/list_model_presets` lists presets; `/model_preset <name>` switches an idle managed session. `/settings` selects the forum default. To edit presets, just say what you want. |
| 📱 | Inspect the current model and reasoning level (`/model`, `/models`, `/switch`, `/effort`) | Read the Mini App header and model/thinking-change markers in the transcript. |
| ❌ | Select model and reasoning level independently (`/model`, `/models`, `/switch`, `/effort`) | No independent selectors. `/model_preset` applies predefined combinations instead. |
| 📱 | Inspect context-use percentage (`/context`) | Read the Mini App header's context gauge. |
| ❌ | Browse detailed context contents (`/context`) | No context inspector. The transcript is not a view of the complete model context. |
| 📱 | View compaction and branch-summary markers | The Mini App transcript displays summaries and changes already made by the host. |
| ❌ | Manually compact or reduce context (`/compact`, `/shake`, `/handoff`) | No controls to initiate these operations. |
| 📱 | Inspect the prompt queue count | The Mini App composer shows the host-reported queued-message count while busy. |
| ❌ | Explicitly queue, edit, remove, or reorder pending prompts (`/queue`) | No queue-management controls. Ordinary prompt delivery still follows the host's queue behavior. |
| 📱 | Read emitted todo and background-job results (`/todo`, `/jobs`) | Inspect their tool cards in the Mini App transcript. These show tool output, not a dedicated live inspector. |
| ❌ | Inspect or edit the live todo list (`/todo`) | No dedicated todo inspector or editor. |
| ❌ | Inspect live background jobs or the complete tool catalog (`/jobs`, `/tools`) | No dedicated job inspector or tool-catalog viewer. |
| ❌ | Service and context modes (`/fast`, `/slow`, `/extended-context`, `/prewalk`) | No dedicated controls. |
| ❌ | Planning and goal modes (`/plan`, `/plan-review`, `/vibe`, `/goal`, `/guided-goal`, `/loop`) | No dedicated mode controls. |
| ❌ | Advisor, security scans, and optimization (`/advisor`, `/security`, `/ratchet`) | No dedicated controls. |
| ❌ | Freeze all agents, force tools, or reset approvals (`/pause`, `/force`, `/force:`, `/forget-approvals`) | No equivalent controls. `/stop` only interrupts the current turn. |
| ❌ | Side tasks, maintenance, and debugging (`/btw`, `/tan`, `/seance`, `/omfg`, `/cleanse`, `/debug`, `/memory`) | No dedicated interfaces. |
| ✅ | Select loaded skills for a prompt (`/skill:<name>`) | `/skills` opens the picker; `/skills clear` clears the selection. |
| ❌ | Search, install, or update registry skills (`/skills`, `omp skill`) | The Telegram `/skills` picker selects loaded skills, not registry management operations. |
| ❌ | Toggle the system-prompt skill listing (`/skillful`) | No toggle. |
| ❌ | Browse or dispatch arbitrary OMP commands (`/init`, discovered file, template, and extension commands) | No command browser or guaranteed built-in slash dispatch. The Mini App composer is not a terminal console. |
| ❌ | Configure OMP or provider authentication (`/settings`, `/setup`, `/providers`, `/login`, `/logout`) | Telegram `/settings` manages forum policy and defaults, not OMP settings or credentials. `/setup` enrolls a forum. |
| ❌ | Manage extensions or MCP (`/extensions`, `/status`, `/marketplace`, `/plugins`, `/plugin`, `/reload-plugins`, `/mcp`) | Telegram `/status` reports service diagnostics, not OMP's extension dashboard. |
| ❌ | Inspect provider limits or open usage dashboards (`/usage`, `/stats`, `/trace`) | No provider-limit, stats, or trace controls. Displayed subagent costs are separate. |
| ✅ | Copy displayed reply text or follow a link | Use Telegram's or the browser's ordinary selection and link actions. |
| ❌ | Use OMP's copy picker or open-last-link command (`/copy`, `/open`) | No equivalent command controls. |
| ❌ | Export, dump requests, or share saved sessions (`/export`, `/dump`, `/share`) | No HTML export, request dump, or encrypted saved-session sharing. |
| 📱 | Change the Mini App's theme | Cycle system, light, and dark appearance in its header. This does not change OMP settings. |
| ❌ | Git, editor, and SSH interfaces (`/git`, `/local`, `/ssh`) | No remote Git UI, local editor, or SSH-host manager. |
| ❌ | Browser and desktop modes (`/browser`, `/computer`) | No host browser or desktop-mode toggles. |
| ❌ | Voice and recording (`/live`, `/record`) | No realtime voice or terminal-recording controls. |
| ❌ | Changelog and shortcuts (`/changelog`, `/hotkeys`) | No corresponding OMP viewers. |
| ❌ | List or clear worktrees (`omp worktree`) | No CLI list or clear interface. |
| ❌ | Browse the complete model catalog or manage agent definitions (`omp models`, `omp agents`) | Preset listing and live subagent controls are separate capabilities above. |
| ❌ | CLI protocols, credentials, and onboarding (`omp acp`, `omp auth`, `omp auth-broker`, `omp auth-gateway`, `omp login`, `omp token`, `omp setup`) | Run locally. Telegram `/setup` is unrelated to OMP onboarding. |
| ❌ | CLI configuration and installation (`omp config`, `omp install`, `omp plugin`, `omp ssh`, `omp tiny-models`, `omp update`, `omp completions`) | Run locally. |
| ❌ | CLI session transfer, storage, and processes (`omp session`, `omp share`, `omp anonymize`, `omp gc`, `omp ps`, `omp shell`) | No equivalent transfer, sharing, storage, process-manager, or shell interfaces. |
| ❌ | CLI coding workflows (`omp git`, `omp commit`, `omp cleanse`, `omp find`, `omp compress`) | No dedicated CLI interfaces. |
| ❌ | CLI inspection and diagnostics (`omp read`, `omp grep`, `omp search`, `omp toks`, `omp ttsr`, `omp images`, `omp grievances`) | Run locally. |
| ❌ | CLI benchmarks and previews (`omp bench`, `omp if-bench`, `omp dry-balance`, `omp gallery`, `omp predict`, `omp render`) | Run locally. |
| ❌ | CLI relay, media, and usage (`omp browser-relay`, `omp clip`, `omp play`, `omp say`, `omp stream`, `omp stats`, `omp usage`) | No relay-management, recording, broadcast, speech, or usage-dashboard interfaces. |

## Setup

1. Install Node.js, pnpm, and [OMP](https://github.com/can1357/oh-my-pi). Configure OMP's model credentials for the account that will run the bot.
2. Open [BotFather](https://t.me/BotFather) in Telegram and send `/newbot`.
   1. Enter a display name for your bot.
   2. Enter an available username ending in `bot`.
   3. Save the API token BotFather returns. Keep it private. You will enter it in `pnpm cli bot add`.
3. Clone and build this project.

   ```sh
   git clone https://github.com/klntsky/omp-telegram-collab.git
   cd omp-telegram-collab
   pnpm install
   pnpm build
   ```

4. Configure the service, register the bot, and choose an existing project directory. Replace `/path/to/project` with your directory.

   Choose the public HTTPS address you will use for the Mini App, such as `https://your-host.example`. Enter it at the `Public HTTPS origin` prompt in `pnpm cli configure`. Set the listen host and port for your reverse proxy or tunnel.

   ```sh
   pnpm cli configure
   pnpm cli bot add
   pnpm cli create /path/to/project
   pnpm start
   ```

   Enter the BotFather token when `bot add` asks. Keep the default Mini App short name, `app`.

5. Point that HTTPS address at the configured listen host and port using a reverse proxy or tunnel with WebSocket support. `pnpm start` uses your configured address to print the BotFather web URL.
6. In BotFather, send `/newapp` to register the Mini App.
   1. Select the bot you created, or send its `@username`.
   2. Enter an app title, such as `OMP Telegram Collab`.
   3. Enter a description, such as `Run coding sessions from Telegram`.
   4. Download the [prepared app photo](assets/botfather-mini-app.png) and upload it when BotFather asks for a photo. It is already 640 × 360 pixels.
   5. Send `/empty` to skip the optional GIF.
   6. For the web URL, paste the complete HTTPS URL printed by `pnpm start`, including `?bot=...`. It looks like `https://your-host.example/?bot=123456789`.
   7. For the short name, enter `app`, matching the value you accepted in `pnpm cli bot add`.
   8. BotFather returns the Telegram launch link, such as `https://t.me/your_bot/app`.

   The topic buttons use this named app's direct link to select the session.

7. Add the bot to a Telegram supergroup with Topics enabled. Promote it to administrator with Manage Topics and Pin Messages permissions. Keep BotFather's default privacy setting. Administrator bots receive ordinary group messages.
8. As a group administrator, send `/setup`. Run the approval command it returns on the service machine.

   ```sh
   pnpm cli approve REQUEST_CODE
   ```

   Select the project directory and prompt settings when asked.

9. Send `/new <your task>` in the group to start a session. Replace `<your task>` with what you want the agent to do. Select **OPEN AGENT** in the new topic to open the Mini App.

