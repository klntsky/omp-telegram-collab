export function help(options: { promptHelp: string; miniApp: boolean; admin: boolean }): string {
  return [
    'Send me a task or a question here. The agent works on the project connected to this group. Each new task starts in its own Telegram topic.',
    '<b>Start a task</b>\n\n<code>/new Find why the login tests fail</code>\nInclude your task in the command. Open the new topic to read the agent’s replies and continue working.',
    `<b>Continue in that topic</b>\n\n<code>/p Check whether the same bug affects signup</code>\n${options.promptHelp.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}`,
    '<b>Group settings</b> · Group admin\n\n<code>/settings</code>\nChange group defaults, prompt permissions, runtime folders, and the session limit.',
    '<b>Stop work</b> · Inside a session topic\n\n<code>/stop</code>\nInterrupt the current task without killing the agent process.\n\n<code>/kill</code>\nForce-stop this topic’s agent process if it is stuck. In-flight work may be lost.',
    '<b>Other tools</b>\n\n<code>/skills</code>\nChoose extra instructions for your next task. Use <code>/skills clear</code> to clear your selection.\n\n<code>/skill_&lt;name&gt; &lt;task&gt;</code>\nSelect a skill and submit a task immediately.\n\n<code>/usage</code>\nCheck model-provider quotas and reset times.\n\n<code>/status</code>\nInspect connection problems and session diagnostics.',
    ...(options.miniApp ? ['<code>/session</code>\nOpen this topic’s live transcript and tool details in the read-only Mini App.'] : []),
    '<b>Administrator tools</b>\n\n<code>/setup</code>\nConnect this group to a project, then open settings.\n\n<code>/model_preset [name]</code>\nChoose a model preset for an idle session or change the group default.\n\n<code>/worktree [branch]</code>\nMove this topic’s session into a separate Git working directory. In General, create a new topic first. The optional branch is a name, not a task.\n\n<code>/fork</code>\nStart a new topic with a copy of this conversation. Reply to an earlier agent answer to copy only through that point.\n\n<code>/attach instanceId [name]</code>\nCreate a topic connected to an agent already running on the bot’s computer.\n\n<code>/detach</code>\nPermanently make this topic conversation-only.',
    ...(options.admin ? ['<code>/cli</code>\nGet a terminal command for joining this topic’s running agent.'] : []),
    '<code>/terminate</code>\nStop all agents across the service and suspend further work. Resuming requires changing the service configuration on the bot’s computer.',
    '<b>Find an administrator</b>\n\n<code>/list_admins</code>\nList this group’s owner and administrators.',
  ].join('\n\n');
}
export const cliCommand = {command:'cli',description:'Copy a local terminal session join command (group admin)'};

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
  { command: 'model_preset', description: 'Browse and use presets or set default; <name> switches idle session' },
  { command: 'help', description: 'Show commands and prompt settings' },
  { command: 'start', description: 'Show bot setup and command guidance' },
];
