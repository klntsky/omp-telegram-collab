export const help = '/setup — request or enroll this forum, then open settings\n/settings — forum defaults and live session count limit (group admin)\n/new task — new topic and session\n/worktree [branch] — 🌳 move this session into an OMP worktree; General creates a topic first\n/attach instanceId [name] — attach local host (group admin)\n/detach — make this topic conversation-only (group admin)\n/modelpreset [name] — browse presets, use one, or make it the forum default; a name switches this idle session (group admin)\n/session — open this session\n/status — host, mirroring, task admission, recovery and skill diagnostics\n/usage — provider plan usage, remaining quotas and resets\n/stop — interrupt the current turn (session topic only)\n/kill — force-kill the host process (session topic only)\n/terminate — terminate all agents and suspend the service (group admin)';
export const settingsHelp = '/settings — forum defaults and live session count limit (group admin)';
export const adminHelp = '/list_admins — list current human group owner and administrators. Manage administrator roles in Telegram.';
export const cliCommand = {command:'cli',description:'Copy a local terminal session join command (group admin)'};
export const cliHelp = '/cli — copy a local terminal session join command (group admin)';
export const terminationMessage = 'The service got terminated, only admin can resume it (remove terminated: true from the config)';
export const groupCommands = [
  { command: 'new', description: 'Start a new session' },
  { command: 'fork', description: 'Fork this session at its tip or a replied message (group admin)' },
  { command: 'worktree', description: '🌳 Move session to an OMP worktree; new topic in General' },
  { command: 'p', description: 'New session in General; prompt in explicit-command topics' },
  { command: 'skills', description: 'Select or clear skills for your next prompt' },
  { command: 'settings', description: 'Forum defaults and live session count limit (group admin)' },
  { command: 'setup', description: 'Request or enroll this forum, then open settings' },
  { command: 'list_admins', description: 'List current human group owner and administrators' },
  { command: 'attach', description: 'Attach a local OMP host (group admin)' },
  { command: 'detach', description: 'Make this topic conversation-only (group admin)' },
  { command: 'session', description: 'Open this topic’s session' },
  { command: 'status', description: 'Show host, mirroring, recovery and skill diagnostics' },
  { command: 'usage', description: 'Show provider plan usage, remaining quotas and resets' },
  { command: 'stop', description: 'Interrupt the current turn in this session topic' },
  { command: 'kill', description: 'Force-kill this session’s host; preserve history' },
  { command: 'terminate', description: 'Terminate all agents and suspend service (group admin)' },
  { command: 'modelpreset', description: 'Browse and use presets or set default; <name> switches idle session' },
  { command: 'help', description: 'Show commands and prompt settings' },
  { command: 'start', description: 'Show bot setup and command guidance' },
];
