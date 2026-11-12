import { createWriteTask, questionScenario, questionStep, writeReadScenario, writeScenario } from '../helpers/model-tasks.js';

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
    document: createWriteTask('document'),
    documentOverwrite: createWriteTask('document-overwrite'),
    documentOnly: { ...createWriteTask('document-only'), prompt: 'e2e-file-only-attachment.txt' },
    documentAlbum: createWriteTask('document-album'),
    documentPreparation: createWriteTask('document-preparation'),
    documentCancellation: createWriteTask('document-cancellation'),
    documentAuthorization: createWriteTask('document-authorization'),
    documentFinalAuthority: createWriteTask('document-final-authority'),
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
    defaultsBusy: createWriteTask('defaults-busy'),
    defaultsManual: createWriteTask('defaults-manual'),
    defaultsNext: createWriteTask('defaults-next'),
    capacityFirst: createWriteTask('capacity-first'),
    capacitySecond: createWriteTask('capacity-second'),
    capacityPending: createWriteTask('capacity-pending'),
    compositeSeed: createWriteTask('composite-seed'),
    compositeSelected: createWriteTask('composite-selected'),
    compositeRecovered: createWriteTask('composite-recovered'),
    compositeNew: createWriteTask('composite-new'),
  };
  const interrupted = { name: 'interrupted', prompt: `Wait for a stop command ${tasks.initial.evidence.nonce}` };
  const cancelledQuestion = { name: 'cancelled-question', prompt: `Ask before the next task ${tasks.initial.evidence.nonce}` };
  // Discussion is model-provided; native askChoice adds only Other automatically:
  // https://github.com/can1357/oh-my-pi/blob/v18.18.6/packages/coding-agent/src/tools/ask.ts.
  const questionControls = ['chat-question', 'dismiss-question'].map(name => ({
    name, prompt: `${name} ${tasks.initial.evidence.nonce}`, steps: name === 'chat-question'
      ? [questionStep(name, ['Local', 'Remote', 'Chat about this']), { type: 'text' as const, text: 'Continue the discussion in Telegram.' }]
      : [questionStep(name)],
  }));
  const scenarios = Object.values(tasks).map(task =>
    task === tasks.defaultsBusy || task === tasks.capacityFirst || task === tasks.capacitySecond
      ? { name: task.name, prompt: task.prompt, steps: [{ type: 'await-abort' as const }] }
      : task === tasks.question || task === tasks.customAnswer ? questionScenario(task)
      : task === tasks.documentOnly ? writeReadScenario(task, task.prompt) : writeScenario(task));
  return { tasks, scenarios, interrupted, cancelledQuestion, questionControls };
}

export type WorkflowTasks = ReturnType<typeof createWorkflowTasks>['tasks'];
export type WorkflowControls = Pick<ReturnType<typeof createWorkflowTasks>, 'interrupted' | 'cancelledQuestion' | 'questionControls'>;
