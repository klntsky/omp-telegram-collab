export interface TopicTarget { readonly generation: number; readonly value: string }
export type TopicFieldState =
  | { kind: 'disabled' }
  | { kind: 'dirty'; target: TopicTarget; retryAt: number }
  | { kind: 'queued'; target: TopicTarget; ticket: number }
  | { kind: 'confirmed'; target: TopicTarget; expiresAt: number }
  | { kind: 'sending'; goal: TopicTarget | undefined; attempt: { readonly ticket: number; readonly target: TopicTarget }; evidence: 'undisturbed' | 'invalidated' };
export type TopicFieldEvent =
  | { type: 'publish'; target?: TopicTarget }
  | { type: 'queue'; ticket: number; now: number }
  | { type: 'dispatch'; ticket: number }
  | { type: 'success'; ticket: number; now: number; lifetime: number }
  | { type: 'failure'; ticket: number; retryAt: number }
  | { type: 'notice'; value: string }
  | { type: 'expire'; now: number };
export function topicGoal(state: TopicFieldState): TopicTarget | undefined {
  return state.kind === 'disabled' ? undefined : state.kind === 'sending' ? state.goal : state.target;
}
function equal(a: TopicTarget | undefined, b: TopicTarget | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && a.generation === b.generation && a.value === b.value);
}
export function transitionTopicField(state: TopicFieldState, event: TopicFieldEvent): TopicFieldState {
  switch (event.type) {
    case 'publish': {
      const target = event.target && Object.freeze({...event.target});
      if (equal(topicGoal(state), target)) return state;
      if (state.kind === 'sending') return {...state, goal: target};
      if (!target) return {kind:'disabled'};
      if (state.kind === 'queued') return {...state,target};
      return {kind:'dirty',target,retryAt:state.kind === 'dirty' ? state.retryAt : 0};
    }
    case 'queue': return state.kind === 'dirty' && state.retryAt <= event.now ? {kind:'queued',target:state.target,ticket:event.ticket} : state;
    case 'dispatch': return state.kind === 'queued' && state.ticket === event.ticket
      ? {kind:'sending',goal:state.target,attempt:Object.freeze({ticket:event.ticket,target:state.target}),evidence:'undisturbed'} : state;
    case 'success':
      if (state.kind === 'sending' && state.attempt.ticket === event.ticket) {
        return state.goal === undefined ? {kind:'disabled'} : equal(state.goal,state.attempt.target) && state.evidence === 'undisturbed'
          ? {kind:'confirmed',target:state.goal,expiresAt:event.now + event.lifetime}
          : {kind:'dirty',target:state.goal,retryAt:0};
      }
      if (state.kind === 'sending') return {...state,evidence:'invalidated'};
      return state.kind === 'confirmed' ? {kind:'dirty',target:state.target,retryAt:0} : state;
    case 'failure':
      if (state.kind === 'sending' && state.attempt.ticket === event.ticket) return state.goal
        ? {kind:'dirty',target:state.goal,retryAt:event.retryAt} : {kind:'disabled'};
      return state.kind === 'queued' && state.ticket === event.ticket ? {kind:'dirty',target:state.target,retryAt:event.retryAt} : state;
    case 'notice':
      if (state.kind === 'sending' && state.attempt.target.value !== event.value) return {...state,evidence:'invalidated'};
      return state.kind === 'confirmed' && state.target.value !== event.value ? {kind:'dirty',target:state.target,retryAt:0} : state;
    case 'expire': return state.kind === 'confirmed' && state.expiresAt <= event.now ? {kind:'dirty',target:state.target,retryAt:0} : state;
  }
}
