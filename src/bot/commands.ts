type HelpOptions =
  | { access: 'setup-admin' }
  | { access: 'setup-member' }
  | { access: 'admin' | 'member'; allMessages: boolean; miniApp: boolean; topicWorktrees: boolean; proposals: boolean };

export function help(options: HelpOptions): string {
  if (options.access === 'setup-admin' || options.access === 'setup-member') {
    return `<b>1. Connect this group</b>

Connect this group to the agent’s computer before starting work in topics.

${options.access === 'setup-admin' ? `<code>/setup</code>
Request a connection to a computer. Someone on the agent’s computer must approve it.` : 'Only a group administrator can connect this group to a computer.'}`;
  }
  const admin = options.access === 'admin';
  const canPrompt = admin || options.proposals;
  let section = 0;
  return `The agent works on the computer connected to this group. Each /new task starts in its own Telegram topic.

${canPrompt ? `<b>${++section}. ${admin ? 'Start a task' : 'Propose a task'}</b>

<code>/new Say hello</code>
The bot will open a new topic.

<b>${++section}. Continue in that topic</b>

<code>/p Tell me more</code>
${options.allMessages
    ? 'You can send ordinary messages as instructions in a topic.'
    : 'Use /p or reply to a bot message in a topic. Other messages and mentions are ignored.'}
In General, /p starts a new topic, like /new.${admin ? '' : '\nYour tasks and follow-up instructions need approval by a group administrator.'}${options.topicWorktrees ? '\nNew topics automatically use separate Git working directories.' : ''}` : `<b>${++section}. Your access</b>

You can follow existing topics, inspect usage and connection diagnostics, and stop work in a topic. Your messages are not sent to the agent.

To submit your own tasks, ask a group administrator to enable task proposals. An administrator must approve each proposed task.`}${admin ? `

<b>${++section}. Group settings</b>

<code>/settings</code>
Change group defaults, prompt permissions, folders on the agent’s computer, and the limit on running agents.
Member task proposals are ${options.proposals ? 'enabled and require administrator approval' : 'disabled'}. Administrators can send tasks directly.` : ''}

<b>${++section}. Stop work</b> · Inside a topic

<code>/stop</code>
Interrupt the current task without killing the agent process.

<code>/kill</code>
Force-stop this topic’s agent process if it is stuck. In-flight work may be lost.

<b>${++section}. Other tools</b>

${canPrompt ? `<code>/skills</code>
Choose extra instructions for your next task. Use <code>/skills clear</code> to clear your selection.

<code>/skill_&lt;name&gt; &lt;task&gt;</code>
Select a skill and submit a task immediately.

` : ''}<code>/usage</code>
Check model-provider quotas and reset times.

<code>/status</code>
Inspect connection problems and topic diagnostics.${options.miniApp ? `

<code>/agent</code>
Open this topic’s live transcript and tool details in the read-only Mini App.` : ''}${admin ? `

<b>${++section}. Administrator tools</b>

<code>/setup</code>
Connect this group to the agent’s computer, then open settings.

<code>/modelpreset [name]</code>
Choose a model preset for an idle topic or change the group default.

<code>/worktree [branch]</code>
Move this topic’s agent into a separate Git working directory. In General, create a new topic first. The optional branch is a name, not a task.

<code>/fork</code>
Start a new topic with a copy of this conversation. Reply to an earlier agent answer to copy only through that point.

<code>/attach instanceId [name]</code>
Create a topic connected to an agent already running on the agent’s computer.

<code>/detach</code>
Permanently make this topic conversation-only.

<code>/cli</code>
Get a terminal command for joining this topic’s running agent.

<code>/terminate</code>
Stop all agents across the service and suspend further work. Resuming requires changing the service configuration on the agent’s computer.` : ''}

<b>${++section}. ${admin ? 'Find administrators' : 'Get more access'}</b>

<code>/list_admins</code>
List this group’s owner and administrators.${admin ? '' : `
Ask them to change group settings, choose model presets, manage topic connections, or grant you an administrator role if you need those controls.`}`;
}
export const cliCommand = {command:'cli',description:'Copy a terminal command to join this topic’s agent (group admin)'};

export const terminationMessage = 'The service got terminated, only admin can resume it (remove terminated: true from the config)';
export const groupCommands = [
  { command: 'new', description: 'Start work in a new topic' },
  { command: 'fork', description: 'Copy this conversation or a replied message to a new topic (group admin)' },
  { command: 'worktree', description: '🌳 Use a separate Git working directory; new topic in General' },
  { command: 'p', description: 'New topic in General; send instructions in an existing topic' },
  { command: 'skills', description: 'Select or clear skills for your next prompt' },
  { command: 'settings', description: 'Group defaults and limit on running agents (group admin)' },
  { command: 'setup', description: 'Request or enroll this forum, then open settings' },
  { command: 'list_admins', description: 'List current human group owner and administrators' },
  { command: 'attach', description: 'Connect a topic to a running agent on the agent’s computer (group admin)' },
  { command: 'detach', description: 'Make this topic conversation-only (group admin)' },
  { command: 'agent', description: 'Open this topic’s transcript and tool details' },
  { command: 'status', description: 'Show host, mirroring, recovery and skill diagnostics' },
  { command: 'usage', description: 'Show provider plan usage, remaining quotas and resets' },
  { command: 'stop', description: 'Interrupt the current task in this topic' },
  { command: 'kill', description: 'Force-stop this topic’s agent; preserve history' },
  { command: 'terminate', description: 'Terminate all agents and suspend service (group admin)' },
  { command: 'modelpreset', description: 'Choose a model preset for an idle topic or set the group default' },
  { command: 'help', description: 'Show commands and prompt settings' },
  { command: 'start', description: 'Show bot setup and command guidance' },
];
