# OMP Telegram Collab

Run [OMP](https://github.com/can1357/oh-my-pi) coding sessions from Telegram forum topics on your own machine. Telegram, the Mini App, and the local OMP terminal connect to the same session.

![OMP Telegram Collab conversations organized into Telegram forum topics](assets/telegram-topics.jpg)

- Give each topic its own conversation and saved history.
- Send prompts and answer agent questions in Telegram or the Mini App.
- Attach existing local OMP sessions.
- Share project directories across groups with configurable prompt approval.
- Edit the included Collab Web client without an iframe.

## OMP feature coverage

Coverage means a user can perform the action through Telegram or the Mini App, not merely ask the agent to do it. Checked items have a remote equivalent. Unchecked items are partial or need local OMP. Command names below are OMP commands, not Telegram commands.

This checklist covers the built-in slash commands and aliases in [OMP 18.14.0](https://github.com/can1357/oh-my-pi/tree/v18.14.0/packages/coding-agent/src/slash-commands), plus the top-level CLI commands reported by that version's `omp --help`. Project and plugin commands vary by installation.

### Sessions and collaboration

- [x] `/new`: create a session in a new Telegram topic.
- [ ] `/session`: partial. Telegram `/session` opens the Mini App, not OMP's session-management commands.
- [ ] `/resume`, `/pin`: managed topics retain and resume their own histories, but there is no remote picker for other saved sessions or pin control.
- [ ] `/rename`, `/move`, `/add-dir`, `/remove-dir`, `/dirs`: no remote OMP session-title or workspace controls.
- [ ] `/branch`, `/rewind`, `/fork`, `/tree`: no remote branching or history navigation controls.
- [ ] `/clear`, `/delete`, `/fresh`, `/retry`: no equivalent remote actions.
- [ ] `/compact`, `/shake`, `/handoff`: automatic compaction is visible, but manual context-management controls are absent.
- [ ] `/wt`, `/worktree`: partial. Telegram `/worktree` creates a separate session from repository HEAD. It does not move the current session or carry uncommitted changes.
- [ ] `/collab`, `/join`, `/leave`: partial. Attach a local host with Telegram `/attach`, open its Mini App, and leave or rejoin the connection. Creating arbitrary share links and joining arbitrary Collab rooms still require OMP.
- [ ] `/export`, `/dump`, `/share`: no remote HTML export, request dump, or encrypted saved-session sharing.
- [ ] `/copy`, `/open`: use ordinary browser selection and links; OMP's conversation picker and last-link action are absent.
- [ ] `/exit`, `/quit`, `/q`, `/restart`: partial. Telegram `/kill` terminates a topic's host and a later prompt can resume a managed session. There is no equivalent orderly exit or same-flags restart control.

### Models, modes, and agent controls

- [ ] `/modelpreset`: partial. Telegram `/model_preset` switches an idle managed session or sets the forum default; `/list_model_presets` lists presets. Creating and saving presets still require OMP.
- [ ] `/model`, `/models`, `/switch`, `/effort`: model and thinking level are visible in the Mini App, but there are no independent remote selectors.
- [ ] `/fast`, `/slow`, `/extended-context`, `/prewalk`: no remote controls.
- [ ] `/plan`, `/plan-review`, `/vibe`, `/goal`, `/guided-goal`, `/loop`, `/queue`: no dedicated remote mode or queue commands.
- [ ] `/advisor`, `/security`, `/ratchet`: no dedicated remote controls.
- [ ] `/hub`, `/subagents`, `/agents`: partial. The Mini App shows subagent transcripts and supports chat, kill, and revive. Per-agent model, prewalk, and advisor configuration are absent.
- [ ] `/todo`, `/jobs`, `/tools`, `/context`: tool activity and transcript entries are visible, but the corresponding inspectors and editors are absent.
- [ ] `/pause`, `/force`, `/force:`, `/forget-approvals`: no equivalent controls. Telegram `/stop` and the Mini App Stop button interrupt a turn rather than freeze all agents.
- [ ] `/btw`, `/tan`, `/seance`, `/omfg`, `/cleanse`, `/debug`, `/memory`: no dedicated remote interfaces.

### Skills, configuration, and local UI

- [x] `/skill:<name>`: Telegram `/skills` selects canonical skill mentions for the next prompt.
- [ ] `/skills`: partial. The Telegram picker selects loaded skills; it does not search, install, or update skills from the OMP registry.
- [ ] `/skillful`: no remote toggle for the system-prompt skill listing.
- [ ] `/init` and discovered file, template, or extension commands: no remote command browser or guaranteed built-in slash dispatch. Prompt text is not a terminal command console.
- [ ] `/settings`, `/setup`, `/providers`, `/login`, `/logout`: no remote OMP settings or provider authentication. Telegram `/setup` configures forum enrollment and prompt policy instead.
- [ ] `/extensions`, `/status`, `/marketplace`, `/plugins`, `/plugin`, `/reload-plugins`, `/mcp`: no remote extension or MCP management. Telegram `/status` reports this service's diagnostics, not OMP's extension dashboard.
- [ ] `/usage`, `/stats`, `/trace`: no provider-limit or stats-dashboard controls.
- [ ] `/git`, `/local`, `/ssh`: no remote Git UI, local editor, or SSH-host manager.
- [ ] `/browser`, `/computer`: no remote host browser or desktop-mode toggles.
- [ ] `/live`, `/record`: no realtime voice or terminal-recording controls.
- [ ] `/changelog`, `/hotkeys`: no corresponding OMP viewers.

### OMP CLI commands

These entries track the CLI workflows separately from similarly named slash commands. No generic remote CLI runner is exposed.

- [ ] `omp collab`, `omp join`: partial. Host discovery and attachment support this project's sessions, not the full CLI sharing and joining workflows.
- [ ] `omp worktree`: partial. Telegram can create a worktree-backed session, but cannot list or clear worktrees.
- [ ] `omp models`, `omp agents`, `omp skill`: partial. Preset listing, subagent controls, and skill selection cover only parts of these management workflows.
- [ ] `omp acp`, `omp auth`, `omp auth-broker`, `omp auth-gateway`, `omp login`, `omp token`, `omp setup`: local protocol, credentials, and onboarding operations.
- [ ] `omp config`, `omp install`, `omp plugin`, `omp ssh`, `omp tiny-models`, `omp update`, `omp completions`: local configuration and installation operations.
- [ ] `omp session`, `omp share`, `omp anonymize`, `omp gc`, `omp ps`, `omp shell`: no equivalent remote session-transfer, sharing, storage, process-manager, or shell interfaces.
- [ ] `omp git`, `omp commit`, `omp cleanse`, `omp find`, `omp compress`: no dedicated remote CLI workflows.
- [ ] `omp read`, `omp grep`, `omp search`, `omp toks`, `omp ttsr`, `omp images`, `omp grievances`: local inspection and diagnostic commands, not remote controls.
- [ ] `omp bench`, `omp if-bench`, `omp dry-balance`, `omp gallery`, `omp predict`, `omp render`: local benchmarking and preview tools.
- [ ] `omp browser-relay`, `omp clip`, `omp play`, `omp say`, `omp stream`, `omp stats`, `omp usage`: no remote relay-management, recording, broadcast, speech, or usage-dashboard interfaces.

Agent tools still run on the host. Missing a remote command does not disable the underlying tool or configured host behavior. See [Product](PRODUCT.md) for current remote behavior and permissions.

## Documentation

- [Product](PRODUCT.md): session behavior, permissions, and user controls.
- [Development](DEVELOPMENT.md): setup, configuration, testing, and deployment.
- [Architecture](ARCHITECTURE.md): component ownership and process and trust boundaries.
