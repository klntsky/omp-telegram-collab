-------------------- MODULE TopicReconciliation --------------------

(***************************************************************************
What this model checks
======================
The bot wants a Telegram topic field to have a particular value. Telegram may
apply an edit after the bot has timed out, changed its mind, or stopped owning
the topic. A success response and a topic-edit notice can arrive independently,
arrive late, or be lost. The question is whether the bot can still distinguish
usable confirmation from stale evidence, and eventually repair a wrong value.

This model describes ONE field, either the title or the icon. A value is the
final representation sent to Telegram. It does not describe title rendering,
icon selection, or two fields running together.

Two different claims are checked:
  Safety: whenever the bot enters "confirmed", its evidence is valid for that
    exact request and the current target. A stale response must not confirm a
    different target.
  Conditional recovery: after the desired target stops changing, the actual
    remote value eventually stays equal to that target, under the progress and
    finite-capacity assumptions explained beside Repair.

"Confirmed" does NOT mean that the remote value is guaranteed to match now.
An old request can apply without any delivered response or notice. Confirmation
is a temporary judgment based on available evidence, not a read of Telegram.
Expiry makes the bot reassert its target even when that hidden write occurs.

TLC explores every reachable ordering within the configured finite domains.
It does not execute TypeScript or contact Telegram. The implementation has
separate tests with representative traces; those are not a proof that every
TypeScript execution corresponds to this specification.

How to read the notation
========================
Each named definition uses ==. Most actions below are predicates describing
one permitted step, not functions called in source order.
  /\ means AND; \/ means OR; ~ means NOT; => means "implies".
  = compares values; # means "not equal"; \in means "is a member of".
  \cap finds set intersection; Nat is the set of nonnegative integers.
  Cardinality counts set members; BOOLEAN is the set {TRUE, FALSE}.
  \E x \in S means "there exists a choice x from set S".
  [field : S] describes a SET of records with field values drawn from S.
  [1..n -> Targets] describes all sequences of n targets. UNION combines
    the sets for every allowed sequence length in the TypeOK check.
  \A x \in S means "for every x from set S".
  Len counts sequence entries; Append adds an entry at the end.
  {a, b} is a set; 1..n is an integer range; \ is set difference.
  \cup joins sets; \subseteq tests whether one set is contained in another.
  [field |-> value] constructs a record; s.field reads a field.
  <<...>> is an ordered sequence; sequence indices start at 1.
  s is the current state; s' is the next state.
  LET name == expression IN body gives an expression a local name.
  IF condition THEN x ELSE y selects one of two values.
  [s EXCEPT !.field = expression] copies s and changes that field only.
  Within an EXCEPT update, @ means that field's OLD value. All expressions
    describe the same step; updates are not sequential assignments.
  []P means P holds always; <>P means P eventually holds.
  <>[]P means that eventually P holds forever.

An action's leading conditions are its guards. If a guard is false, that action
cannot take that step. Next offers all actions as alternatives, so an enabled
Apply is not required to happen before an enabled Timeout or Publish.

A concrete failure and its repair
=================================
Suppose the saved display, desired title and remote title all start at A.
  1. Publish B, then Queue and Dispatch request 1 carrying B.
  2. Publish A again before request 1 completes. Its sent value remains B.
  3. Apply(1) puts B on Telegram. Ack(1) arrives after the goal reverted to A.
  4. The correct rule returns to dirty instead of confirming A from B's response.
  5. Queue and Dispatch request 2 carrying A. Apply(2) restores Telegram to A.
The storedName variant stalls at step 5 because saved display still equals A.
The staleAck variant can falsely confirm at step 4. These are distinct bugs:
one prevents repair, while the other invents evidence of success.
***************************************************************************)
EXTENDS Naturals, FiniteSets, Sequences, TLC

CONSTANTS Values, Generations, MaxRequests, Mutation

(***************************************************************************
The .cfg files supply the finite search space and choose the experiment.
Values uses abstract labels such as a and b, not particular Telegram strings.
Generations distinguishes ownership epochs even when the visible value is the
same. A target is the PAIR of generation and value. This model does not impose
an ordering on the generation labels.
MaxRequests bounds the total number of dispatches in a run. Request identities
increase and are never reused, even after timeout.

Mutation = "correct" checks the intended rules. The other settings deliberately
break one rule so the checker must find a counterexample:
  staleAck: let an old success confirm the current target.
  goalNotice: compare a notice to the newest goal instead of the sent target.
  noLease: never expire a confirmation.
  storedName: skip a write because the stored display already equals the goal.

The safety config uses two values, two generations, and two request identities.
The liveness config uses two values, one generation, and three identities.
These are exhaustive finite checks, not a theorem for arbitrarily many values,
ownership changes, requests, or concurrent topics.
***************************************************************************)
ASSUME /\ Cardinality(Values) >= 2
       /\ Cardinality(Generations) >= 1
       /\ MaxRequests \in Nat \ {0}
       /\ Mutation \in {"correct", "staleAck", "goalNotice", "noLease", "storedName"}

(***************************************************************************
The boundary between the bot and Telegram
========================================
Publish and Disable represent decisions already made by the rest of the bot.
Queue, Dispatch, Ack, Timeout, Notice and Expire represent the field protocol.
Apply, Reject, LoseAck and LoseNotice represent the external system and network.
Stabilize is a modeling device for the eventual-recovery premise.

Application, response delivery and notice delivery are separate actions. There
is no ordering between different requests, or between a response and a notice.
Each applied request can lose both its response and its notice. A request can
still apply after timeout, disable, or a generation change. There are no retries
inside a request; a retry dispatches a new identity.

Fresh and expired stand for time passing. There is no wall-clock duration,
clock bound, or expiry budget. Expiry can recur after every confirmation.
Exhausting MaxRequests does not discard outstanding requests or stop expiry.

This model does not include persistence, source-event ingestion, chat admission
fairness, host lookup, rate-limit cooldown, or independence between fields.
It cannot establish those implementation properties or validate Telegram's
actual behavior. The external actions above state the behavior assumed here.

The independent check
=====================
The bot's evidence flag is the algorithm under test. The disturbed set is a
separate history maintained by the model's checker-side rules. Those rules mark
an attempt when an observed contradiction makes its success insufficient.
CanCertify reads that history, not the algorithm's evidence flag. Every attempt
to confirm records that independent verdict in certificate.

This separation matters for the deliberately broken variants. A broken rule
cannot declare its own evidence valid and thereby make the invariant pass.
Notices never confirm. Remote equality alone is not confirmation evidence.
***************************************************************************)
Targets == [enabled : {TRUE}, generation : Generations, value : Values]
Ids == 1..MaxRequests
NoTarget == [enabled |-> FALSE,
             generation |-> CHOOSE g \in Generations : TRUE,
             value |-> CHOOSE v \in Values : TRUE]
Modes == {"disabled", "dirty", "queued", "sending", "confirmed"}

(***************************************************************************
State dictionary
================
All mutable state lives in one record s. This is a convenient way to express
updates; it is not the layout of the TypeScript object or database.

mode describes the bot's local protocol stage:
  disabled: no target is currently eligible for publication.
  dirty: a target needs a write, but it has not entered the delivery queue.
  queued: waiting for dispatch; the goal may still change before dispatch.
  sending: one local attempt is pending, possibly with a newer or disabled goal.
  confirmed: a matching success supplied usable evidence, until invalidation
    or expiry. Older timed-out requests may still exist remotely.

goal is the current desired target. NoTarget represents no eligible target.
Its generation and value are arbitrary placeholders, not a hidden desired
value. CHOOSE selects a domain member so every goal record has the same fields.

requests is the immutable history of dispatched targets. requests[i] is what
request i actually sent, regardless of later changes to goal.
flight is the locally pending request ID while mode is sending. Outside that
mode, flight may retain an old ID and must not be treated as an active request.
evidence says whether the algorithm has seen a reason not to trust that attempt.
lease is fresh after confirmation and expired when reassertion becomes due.

remote is the actual Telegram value. It changes only in Apply. The algorithm
does not use remote to decide whether an acknowledgment can confirm.
applied and rejected record the external outcome of each dispatched request.
outcomes records successful responses that were either delivered or lost.
notices records edit notices that were either delivered or lost.
These sets prevent the same event from being delivered twice.

disturbed and certificate belong to the independent check described above.
storedDisplay is the application's saved display value, not a remote read.
staleDisplayOutcome records the particular race needed by the storedName
negative check. stable locks future input changes for the recovery experiment.

This record is larger than the production protocol state on purpose.
remote and the event-history sets describe the external world for the checker.
disturbed and certificate check the algorithm independently. stable and
staleDisplayOutcome select the recovery experiments. They are not extra flags
that the TypeScript implementation must maintain.
The full requests sequence lets the checker deliver arbitrary old effects.
Production callbacks retain their own immutable attempt instead of keeping
this entire model history in the field state.

Why the protocol remembers more than the latest value
====================================================
The same current goal can follow two histories that need different decisions:
  Sent target: a success for A may confirm goal A; a success for old B may not.
  Request identity: two attempts may send A, but only the current one's success
    can confirm. The queue also needs to reject a replaced job's dispatch.
  Generation: an attempt from an old owner cannot confirm a new owner's goal,
    even if both owners want the same visible value.
  Contradiction history: seeing B and then A while awaiting A is not equivalent
    to seeing only A. The matching last notice must not erase the earlier doubt.
  Disabled goal: a draining attempt may finish without enabling publication.
  Lease: equal confirmed values can require different actions because one
    confirmation has expired and the other is still fresh.

These distinctions justify information retained by this acknowledgment-based
protocol. They do not prove that this exact representation, every scheduler
field, or the whole implementation is minimal. A different protocol could make
more conservative decisions or reassert values periodically instead. Such a
design needs its own analysis of repair latency and redundant Telegram writes.
***************************************************************************)
VARIABLE s
vars == <<s>>
\* The tuple vars tells the temporal and fairness formulas which state can change.


(***************************************************************************
Start with an enabled target that needs a write and no dispatched requests.
Both the desired target and the initial remote value are arbitrary choices.
The checker must consider a remote value that is already right as well as one
that is wrong. storedDisplay initially equals the goal; that equality alone
does not establish anything about remote.
***************************************************************************)
Init == \E initial \in Targets, initialRemote \in Values :
        s = [mode |-> "dirty", goal |-> initial,
             flight |-> 0, evidence |-> TRUE, lease |-> "expired",
             requests |-> <<>>, applied |-> {}, rejected |-> {},
             outcomes |-> {}, notices |-> {},
             disturbed |-> {},
             storedDisplay |-> initial.value,
             remote |-> initialRemote,
             certificate |-> FALSE, stable |-> FALSE,
             staleDisplayOutcome |-> FALSE]

(***************************************************************************
Helpers used below
Sent lists the dispatched IDs. Eligible means the goal is enabled.
SameAttempt requires the current goal to match BOTH fields of requests[i].
CanCertify additionally requires that i is the local active attempt and has no
independently recorded contradiction. NextMode chooses dirty or disabled from
the current goal after an attempt can no longer confirm it.
***************************************************************************)
Sent == 1..Len(s.requests)
Eligible == s.goal.enabled
SameAttempt(i) == Eligible /\ s.goal = s.requests[i]
CanCertify(i) == /\ s.mode = "sending" /\ s.flight = i
                 /\ SameAttempt(i) /\ i \notin s.disturbed
NextMode == IF Eligible THEN "dirty" ELSE "disabled"

(***************************************************************************
Input changes
Publish selects a different target, including a different generation with the
same visible value. A queued write picks up that latest goal at Dispatch.
A sending write retains its immutable sent target; only goal changes.
A previously confirmed target becomes dirty because that evidence is now old.
***************************************************************************)
Publish(t) ==
  /\ ~s.stable /\ t \in Targets /\ t # s.goal
  /\ s' = [s EXCEPT !.goal = t,
              !.mode = IF @ \in {"disabled", "confirmed"} THEN "dirty" ELSE @,
              !.certificate = FALSE]

(***************************************************************************
Disable removes the goal but does not cancel a remote effect already in flight.
Keep a sending attempt around to process its eventual response or notice.
For all other stages there is no local attempt to drain, so enter disabled.
***************************************************************************)
Disable ==
  /\ ~s.stable /\ Eligible
  /\ s' = [s EXCEPT !.goal = NoTarget,
              !.mode = IF @ = "sending" THEN @ ELSE "disabled",
              !.certificate = FALSE]

(***************************************************************************
Stabilize means "from now on, the desired target stays enabled and unchanged".
It disables Publish and Disable, not delivery, timeout, notices, or expiry.
Safety also explores runs that never stabilize. Recovery is conditional on
eventually taking this step.
***************************************************************************)
Stabilize ==
  /\ ~s.stable /\ Eligible
  /\ s' = [s EXCEPT !.stable = TRUE]

(***************************************************************************
Queue changes dirty to queued. It makes no network request.
storedDisplay is application display state, never remote confirmation evidence.
The original equality-suppression mutant refuses admission when it matches the
desired value. StoredNameRepair requires a delivered superseded successful
outcome, so its counterexample cannot merely exploit unknown startup metadata.
Only a current matching successful ack commits display; superseded success does
not commit it. This models the stale temporary-write/baseline-reversion failure.
***************************************************************************)
Queue ==
  /\ s.mode = "dirty"
  /\ (Mutation # "storedName" \/ s.goal.value # s.storedDisplay)
  /\ s' = [s EXCEPT !.mode = "queued"]

(***************************************************************************
Dispatch freezes the current target into the next request-history entry.
Evidence starts undisturbed for this new attempt. A local slot is not a lock on
Telegram: an earlier timed-out request can still apply after this dispatch.
***************************************************************************)
Dispatch ==
  /\ s.mode = "queued" /\ Eligible /\ Len(s.requests) < MaxRequests
  /\ s' = [s EXCEPT !.mode = "sending", !.flight = Len(s.requests) + 1,
              !.requests = Append(@, s.goal), !.evidence = TRUE,
              !.certificate = FALSE]

(***************************************************************************
Apply is the remote side effect, not the success response. Any unresolved
dispatched request may apply, including an old one whose local slot is gone.
An older request applying after a newer request can therefore overwrite it.
***************************************************************************)
Apply(i) ==
  /\ i \in Sent \ (s.applied \cup s.rejected)
  /\ s' = [s EXCEPT !.applied = @ \cup {i}, !.remote = s.requests[i].value]

(***************************************************************************
Reject means Telegram does not apply that request. This abstraction does not
deliver a separate failure callback. Timeout can release the local attempt.
***************************************************************************)
Reject(i) ==
  /\ i \in Sent \ (s.applied \cup s.rejected)
  /\ s' = [s EXCEPT !.rejected = @ \cup {i}]

(***************************************************************************
Ack delivers a successful response for a request that has already applied.
The correct algorithm confirms only its current attempt, with an unchanged
target and undisturbed evidence. Otherwise a completed current attempt makes
the current goal dirty, or disabled if there is no goal.

A late success from another attempt also invalidates an existing confirmation
or disturbs a newer local attempt. It proves that an older write took effect;
it does not prove which request's value is now on Telegram.

confirms is the algorithm's decision, including the staleAck fault injection.
certificate is the independent verdict from CanCertify. The invariant below
catches a decision to confirm when that verdict is false.
storedDisplay commits only a current, matching successful response. The
staleDisplayOutcome flag records a superseded success while the reverted goal
still equals that saved display, for the original-race negative check.
***************************************************************************)
Ack(i) ==
  /\ i \in s.applied \ s.outcomes
  /\ LET current == s.mode = "sending" /\ s.flight = i
         confirms == (current /\ SameAttempt(i) /\ s.evidence)
                     \/ (Mutation = "staleAck" /\ ~current /\ Eligible)
         lateFlight == ~current /\ s.mode = "sending"
     IN s' = [s EXCEPT
         !.outcomes = @ \cup {i},
         !.storedDisplay = IF current /\ SameAttempt(i)
                           THEN s.requests[i].value ELSE @,
         !.staleDisplayOutcome = @ \/
             (Mutation = "storedName" /\ Eligible /\
              s.goal.value = s.storedDisplay /\
              s.requests[i].value # s.storedDisplay),
         !.mode = IF confirms THEN "confirmed"
                  ELSE IF current \/ s.mode = "confirmed" THEN NextMode ELSE @,
         !.certificate = IF confirms THEN CanCertify(i) ELSE FALSE,
         !.lease = IF confirms THEN "fresh" ELSE @,
         !.evidence = IF lateFlight THEN FALSE ELSE @,
         !.disturbed = IF lateFlight THEN @ \cup {s.flight} ELSE @]

(***************************************************************************
LoseAck consumes the response without telling the bot. The remote edit has
already happened. No local confirmation follows from this lost response.
***************************************************************************)
LoseAck(i) ==
  /\ i \in s.applied \ s.outcomes
  /\ s' = [s EXCEPT !.outcomes = @ \cup {i}]

(***************************************************************************
Timeout releases the local attempt and schedules repair if there is a goal.
It neither removes the request history nor marks the request rejected.
Its remote effect and response can still arrive later.
***************************************************************************)
Timeout ==
  /\ s.mode = "sending"
  /\ s' = [s EXCEPT !.mode = NextMode, !.certificate = FALSE]

(***************************************************************************
Notice delivers an edit observation, not proof that the latest write succeeded.
Its value is the value of the request that generated it, not a fresh remote read.
It can be arbitrarily delayed, including across a change from A to B and back
to A. This is the ABA case: equal current values can hide intervening changes.

While sending, compare the notice with the immutable SENT target, even if the
current goal changed or was disabled. A mismatch invalidates evidence and marks
the active request in the independent disturbed history. The goalNotice mutant
instead compares against the latest goal and incorrectly ignores disabled goals.

A mismatch while confirmed makes the goal dirty. A matching notice does not
confirm, restore invalidated evidence, or renew the lease.
An attributable native edit belongs to source ingestion, outside this model.
***************************************************************************)
Notice(i) ==
  /\ i \in s.applied \ s.notices
  /\ LET v == s.requests[i].value
         mismatch == s.mode = "sending" /\ v # s.requests[s.flight].value
         algorithmMismatch == IF Mutation = "goalNotice"
                              THEN s.mode = "sending" /\ Eligible /\ v # s.goal.value
                              ELSE mismatch
         contradicts == s.mode = "confirmed" /\ v # s.goal.value
     IN s' = [s EXCEPT
         !.notices = @ \cup {i},
         !.disturbed = IF mismatch THEN @ \cup {s.flight} ELSE @,
         !.evidence = IF algorithmMismatch THEN FALSE ELSE @,
         !.mode = IF contradicts THEN "dirty" ELSE @,
         !.certificate = IF contradicts THEN FALSE ELSE @]

(***************************************************************************
LoseNotice consumes an edit observation without delivering it. Apply already
changed remote, so losing both notice and response can hide a remote change.
***************************************************************************)
LoseNotice(i) ==
  /\ i \in s.applied \ s.notices
  /\ s' = [s EXCEPT !.notices = @ \cup {i}]

(***************************************************************************
Expire makes a confirmed target dirty so the bot eventually reasserts it.
This repairs writes hidden by lost responses and notices. noLease removes this
action to demonstrate that the remaining protocol alone cannot ensure repair.
***************************************************************************)
Expire ==
  /\ s.mode = "confirmed" /\ s.lease = "fresh"
  /\ Mutation # "noLease"
  /\ s' = [s EXCEPT !.mode = "dirty", !.lease = "expired",
              !.certificate = FALSE]

(***************************************************************************
One step is ANY enabled alternative below. The checker explores their possible
interleavings rather than following this list in order.
***************************************************************************)
Next == \/ \E t \in Targets : Publish(t)
        \/ Disable \/ Stabilize \/ Queue \/ Dispatch \/ Timeout \/ Expire
        \/ \E i \in Ids : Apply(i) \/ Reject(i) \/ Ack(i) \/ LoseAck(i)
                          \/ Notice(i) \/ LoseNotice(i)

(***************************************************************************
Safety checks
TypeOK checks the domains of all fields and consistency of the event histories.
StateShape checks the local protocol shape: disabled has no eligible goal;
dirty, queued and confirmed have one; sending refers to a dispatched request.
Sending is deliberately allowed with a disabled goal so old work can drain.
ConfirmationEvidence requires the independent certificate whenever the bot
claims confirmation. It does NOT assert remote = goal in every confirmed state.
***************************************************************************)
TypeOK ==
  /\ s.mode \in Modes /\ s.goal \in Targets \cup {NoTarget}
  /\ s.flight \in 0..MaxRequests /\ s.evidence \in BOOLEAN
  /\ s.lease \in {"fresh", "expired"}
  /\ s.requests \in UNION {[1..n -> Targets] : n \in 0..MaxRequests}
  /\ s.applied \subseteq Sent /\ s.outcomes \subseteq s.applied
  /\ s.notices \subseteq s.applied /\ s.disturbed \subseteq Sent
  /\ s.rejected \subseteq Sent /\ s.rejected \cap s.applied = {}
  /\ s.remote \in Values /\ s.certificate \in BOOLEAN
  /\ s.storedDisplay \in Values
  /\ s.staleDisplayOutcome \in BOOLEAN
  /\ s.stable \in BOOLEAN
StateShape ==
  /\ (s.mode = "disabled" => ~Eligible)
  /\ (s.mode \in {"dirty", "queued", "confirmed"} => Eligible)
  /\ (s.mode = "sending" => s.flight \in Sent)
ConfirmationEvidence == s.mode = "confirmed" => s.certificate

(***************************************************************************
SafetySpec starts in Init and requires every later step to satisfy Next or leave
the state unchanged. [][Next]_vars is TLA+'s notation for that rule with
"stuttering" allowed. Waiting without a visible change is therefore legal.
Safety excludes bad reachable states; it does not require useful progress.
***************************************************************************)
SafetySpec == Init /\ [][Next]_vars

(***************************************************************************
Conditional recovery and its assumptions
=======================================
Fairness rules exclude schedules that postpone certain enabled actions forever.
WF_vars(A), called weak fairness, means that if action A remains enabled, A must
eventually take a step. It does not promise a deadline.

Queue and Dispatch eventually run when continuously eligible. A local pending
attempt eventually times out if nothing completes it. Each dispatched request
eventually either applies or is rejected. With finitely many request IDs, these
assumptions mean older remote effects cannot keep arriving forever.

Expiry is fair whenever a confirmed target differs from remote. This is weaker
than requiring periodic expiry unconditionally. The fairness expression uses
remote to describe the assumed schedule; Expire itself does NOT inspect remote.
Ack and Notice are not required to arrive. Both may be lost.

CapacityAdequate says that after stabilization, each dirty or queued state has
an unused request identity. It explicitly excludes runs that need more repairs
than this finite model can dispatch. Fairness alone would not fix exhaustion.
Runs may stop expiring once the value stays correct, so the premise need not
consume request identities forever.

Repair reads: IF inputs eventually stabilize AND capacity stays adequate, THEN
eventually the goal remains enabled and the actual remote value stays equal to
it forever. This is a claim about the remote value, not eventual confirmation.
It is NOT unconditional convergence, a wall-clock bound, or an unbounded retry
proof. Without these premises the property makes no recovery claim.
***************************************************************************)
CapacityAdequate == []((s.stable /\ s.mode \in {"dirty", "queued"})
                       => Len(s.requests) < MaxRequests)
Fairness == /\ WF_vars(Queue) /\ WF_vars(Dispatch) /\ WF_vars(Timeout)
            /\ WF_vars(Expire /\ s.remote # s.goal.value)
            /\ \A i \in Ids : WF_vars(Apply(i) \/ Reject(i))
LiveSpec == SafetySpec /\ Fairness
Repair == (<>s.stable /\ CapacityAdequate)
          => <>[](Eligible /\ s.remote = s.goal.value)

(***************************************************************************
StoredNameRepair narrows the negative recovery experiment to the original race.
First send a temporary value, then revert the goal to the saved display value.
Deliver the superseded successful response while that equality still holds.
The storedName mutant suppresses the corrective write because it trusts the
saved display instead of remote-write evidence.

The implication below requires Repair only on runs that reach this witness.
A stall caused solely by an initially unknown remote value cannot count as the
counterexample. The checker must reproduce the superseded-success race.
***************************************************************************)
StoredNameRepair == (<>s.staleDisplayOutcome) => Repair
=============================================================================
