import { createWriteTask, questionScenario, questionStep, writeScenario } from '../helpers/model-tasks.js';

export function createWorkflowTasks() {
  const tasks = {
    lifecycleSeed: createWriteTask('lifecycle-seed'),
    identitySeed: createWriteTask('identity-seed'),
    terminationSeed: createWriteTask('termination-seed'),
    lifecyclePeer: createWriteTask('lifecycle-peer'),
    terminationPeer: createWriteTask('termination-peer'),
    initial: createWriteTask('initial', '\n/home/example/project/error.ts:27\n  throw new Error("Original diagnostic");\n    at run (/home/example/project/error.ts:27:11)\n/stop /unknown'),
    worktree: createWriteTask('worktree'),
    worktreeRestarted: createWriteTask('worktree-restarted'),
    question: createWriteTask('question'),
    customAnswer: createWriteTask('custom-answer'),
    askHandoff: createWriteTask('ask-handoff'),
    chatHandoff: createWriteTask('chat-handoff'),
    settingsReply: createWriteTask('settings-reply'),
    image: createWriteTask('image'),
    explicitImage: createWriteTask('explicit-image'),
    followup: createWriteTask('followup', '\nPreserve this second line.'),
    general: createWriteTask('general'),
    resumed: createWriteTask('resumed'),
    reopened: createWriteTask('reopened'),
    idle: createWriteTask('idle'),
    separate: createWriteTask('separate'),
    restarted: createWriteTask('restarted'),
    restored: createWriteTask('restored'),
    forkTip: createWriteTask('fork-tip'),
    forkAnswer: createWriteTask('fork-answer'),
    forkPrompt: createWriteTask('fork-prompt'),
    identityOld: createWriteTask('identity-old'),
    identityNew: createWriteTask('identity-new'),
    identityOldRestarted: createWriteTask('identity-old-restarted'),
    identityNewRestarted: createWriteTask('identity-new-restarted'),
    defaultsFirst: createWriteTask('defaults-first'),
    defaultsUnchanged: createWriteTask('defaults-unchanged'),
    defaultsSwitched: createWriteTask('defaults-switched'),
    defaultsManual: createWriteTask('defaults-manual'),
    defaultsNext: createWriteTask('defaults-next'),
    capacityFirst: createWriteTask('capacity-first'),
    capacitySecond: createWriteTask('capacity-second'),
    capacityPending: createWriteTask('capacity-pending'),
  };
  const interrupted = { name: 'interrupted', prompt: `Wait for a stop command ${tasks.initial.evidence.nonce}` };
  const cancelledQuestion = { name: 'cancelled-question', prompt: `Ask before the next task ${tasks.initial.evidence.nonce}` };
  const questionControls = ['chat-question', 'dismiss-question'].map(name => ({
    name, prompt: `${name} ${tasks.initial.evidence.nonce}`, steps: name === 'chat-question'
      ? [questionStep(name), { type: 'text' as const, text: 'Continue the discussion in Telegram.' }]
      : [questionStep(name)],
  }));
  const scenarios = Object.values(tasks).map(task =>
    task === tasks.capacityFirst || task === tasks.capacitySecond
      ? { name: task.name, prompt: task.prompt, steps: [{ type: 'await-abort' as const }] }
      : task === tasks.question || task === tasks.customAnswer ? questionScenario(task) : writeScenario(task));
  return { tasks, scenarios, interrupted, cancelledQuestion, questionControls };
}

export type WorkflowTasks = ReturnType<typeof createWorkflowTasks>['tasks'];
export type WorkflowControls = Pick<ReturnType<typeof createWorkflowTasks>, 'interrupted' | 'cancelledQuestion' | 'questionControls'>;
