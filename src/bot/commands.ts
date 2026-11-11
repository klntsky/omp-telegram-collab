type HelpOptions =
  | { access: 'setup-admin' }
  | { access: 'setup-member' }
  | { access: 'admin' | 'member'; allMessages: boolean; miniApp: boolean; topicWorktrees: boolean; proposals: boolean };

export function help(options: HelpOptions): string {
  if (options.access === 'setup-admin' || options.access === 'setup-member') {
    return `<b>This group is not connected yet</b>

The bot needs a project connection before you can use coding sessions.

${options.access === 'setup-admin' ? `<code>/setup</code>
Request a connection to a project. The operator on the bot’s computer must approve it.` : 'Ask a group administrator to connect this group to a project. After setup, ask them to enable task proposals if you want to submit your own tasks.'}`;
  }
  const admin = options.access === 'admin';
  const canPrompt = admin || options.proposals;
  return `The agent works on the project connected to this group. Each new task starts in its own Telegram topic.

${canPrompt ? `<b>${admin ? 'Start a task' : 'Propose a task'}</b>

<code>/new Find why the login tests fail</code>
Include your task in the command. Open the new topic to read the agent’s replies and continue working.

<b>Continue in that topic</b>

<code>/p Check whether the same bug affects signup</code>
${options.allMessages
    ? 'You can send ordinary messages as instructions in a session topic.'
    : 'Use /p or reply to a bot message in a session topic. Other messages and mentions are ignored.'}
In General, /p starts a new topic, like /new.${admin ? '' : '\nYour tasks and follow-up instructions need approval by a group administrator.'}${options.topicWorktrees ? '\nNew session topics automatically use separate Git working directories.' : ''}` : `<b>Your access</b>

You can follow existing sessions, inspect usage and connection diagnostics, and stop work in a session topic. Your messages are not sent to the agent.

To submit your own tasks, ask a group administrator to enable task proposals. An administrator must approve each proposed task.`}${admin ? `

<b>Group settings</b>

<code>/settings</code>
Change group defaults, prompt permissions, runtime folders, and the session limit.
Member task proposals are ${options.proposals ? 'enabled and require administrator approval' : 'disabled'}. Administrators can send tasks directly.` : ''}

<b>Stop work</b> · Inside a session topic

<code>/stop</code>
Interrupt the current task without killing the agent process.

<code>/kill</code>
Force-stop this topic’s agent process if it is stuck. In-flight work may be lost.

<b>Other tools</b>

${canPrompt ? `<code>/skills</code>
Choose extra instructions for your next task. Use <code>/skills clear</code> to clear your selection.

<code>/skill_&lt;name&gt; &lt;task&gt;</code>
Select a skill and submit a task immediately.

` : ''}<code>/usage</code>
Check model-provider quotas and reset times.

<code>/status</code>
Inspect connection problems and session diagnostics.${options.miniApp ? `

<code>/session</code>
Open this topic’s live transcript and tool details in the read-only Mini App.` : ''}${admin ? `

<b>Administrator tools</b>

<code>/setup</code>
Connect this group to a project, then open settings.

<code>/model_preset [name]</code>
Choose a model preset for an idle session or change the group default.

<code>/worktree [branch]</code>
Move this topic’s session into a separate Git working directory. In General, create a new topic first. The optional branch is a name, not a task.

<code>/fork</code>
Start a new topic with a copy of this conversation. Reply to an earlier agent answer to copy only through that point.

<code>/attach instanceId [name]</code>
Create a topic connected to an agent already running on the bot’s computer.

<code>/detach</code>
Permanently make this topic conversation-only.

<code>/cli</code>
Get a terminal command for joining this topic’s running agent.

<code>/terminate</code>
Stop all agents across the service and suspend further work. Resuming requires changing the service configuration on the bot’s computer.` : ''}

<b>${admin ? 'Find administrators' : 'Get more access'}</b>

<code>/list_admins</code>
List this group’s owner and administrators.${admin ? '' : `
Ask them to change group settings, choose model presets, manage session connections, or grant you an administrator role if you need those controls.`}`;
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
