-------------------- MODULE TopicReconciliation --------------------
EXTENDS Naturals, FiniteSets, Sequences, TLC

CONSTANTS Values, Generations, MaxRequests, Mutation
ASSUME /\ Cardinality(Values) >= 2
       /\ Cardinality(Generations) >= 1
       /\ MaxRequests \in Nat \ {0}
       /\ Mutation \in {"correct", "staleAck", "goalNotice", "noLease", "storedName"}

(***************************************************************************
One physical field; value is the final Telegram representation, not a display
fallback. Targets include generation. No persistence, source ingestion,
chat arbitration, host lookup, cooldown or multi-field independence is proved.
Requests have strictly increasing identities, never reused. At most MaxRequests
can be dispatched. Exhaustion does NOT silently discard requests or stop expiry.
Fresh/expired abstracts time, without a clock bound or expiry budget. Expiry can
recur after every confirmation. No wall-clock convergence claim.
A request can apply after timeout/disable/generation change. Application, outcome
and notice delivery are separate actions; each applied request can lose its ack
and its notice. No order between different requests or ack and notice is assumed.

The oracle's disturbed set is independent of the reducer's evidence flag.
Every Confirm transition records its own certificate validity from the immutable
request and oracle history, so a mutant cannot prove itself using its own flag.
Notices never confirm. Remote equality alone is deliberately not a certificate.
***************************************************************************)
Targets == [enabled : {TRUE}, generation : Generations, value : Values]
Ids == 1..MaxRequests
NoTarget == [enabled |-> FALSE,
             generation |-> CHOOSE g \in Generations : TRUE,
             value |-> CHOOSE v \in Values : TRUE]
Modes == {"disabled", "dirty", "queued", "sending", "confirmed"}
VARIABLE s
vars == <<s>>

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

Sent == 1..Len(s.requests)
Eligible == s.goal.enabled
SameAttempt(i) == Eligible /\ s.goal = s.requests[i]
CanCertify(i) == /\ s.mode = "sending" /\ s.flight = i
                 /\ SameAttempt(i) /\ i \notin s.disturbed
NextMode == IF Eligible THEN "dirty" ELSE "disabled"

Publish(t) ==
  /\ ~s.stable /\ t \in Targets /\ t # s.goal
  /\ s' = [s EXCEPT !.goal = t,
              !.mode = IF @ \in {"disabled", "confirmed"} THEN "dirty" ELSE @,
              !.certificate = FALSE]
Disable ==
  /\ ~s.stable /\ Eligible
  /\ s' = [s EXCEPT !.goal = NoTarget,
              !.mode = IF @ = "sending" THEN @ ELSE "disabled",
              !.certificate = FALSE]
Stabilize ==
  /\ ~s.stable /\ Eligible
  /\ s' = [s EXCEPT !.stable = TRUE]

(***************************************************************************
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
Dispatch ==
  /\ s.mode = "queued" /\ Eligible /\ Len(s.requests) < MaxRequests
  /\ s' = [s EXCEPT !.mode = "sending", !.flight = Len(s.requests) + 1,
              !.requests = Append(@, s.goal), !.evidence = TRUE,
              !.certificate = FALSE]
Apply(i) ==
  /\ i \in Sent \ (s.applied \cup s.rejected)
  /\ s' = [s EXCEPT !.applied = @ \cup {i}, !.remote = s.requests[i].value]
Reject(i) ==
  /\ i \in Sent \ (s.applied \cup s.rejected)
  /\ s' = [s EXCEPT !.rejected = @ \cup {i}]

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

LoseAck(i) ==
  /\ i \in s.applied \ s.outcomes
  /\ s' = [s EXCEPT !.outcomes = @ \cup {i}]
Timeout ==
  /\ s.mode = "sending"
  /\ s' = [s EXCEPT !.mode = NextMode, !.certificate = FALSE]

(***************************************************************************
A notice is an observation only, including when the goal is disabled. Queued
notices carry the value of the application that generated them, not the current
remote value. This allows independent, arbitrarily delayed delivery and ABA.
An attributable native edit belongs to input ingestion, outside this field model.
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
LoseNotice(i) ==
  /\ i \in s.applied \ s.notices
  /\ s' = [s EXCEPT !.notices = @ \cup {i}]
Expire ==
  /\ s.mode = "confirmed" /\ s.lease = "fresh"
  /\ Mutation # "noLease"
  /\ s' = [s EXCEPT !.mode = "dirty", !.lease = "expired",
              !.certificate = FALSE]

Next == \/ \E t \in Targets : Publish(t)
        \/ Disable \/ Stabilize \/ Queue \/ Dispatch \/ Timeout \/ Expire
        \/ \E i \in Ids : Apply(i) \/ Reject(i) \/ Ack(i) \/ LoseAck(i)
                          \/ Notice(i) \/ LoseNotice(i)

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

SafetySpec == Init /\ [][Next]_vars

(***************************************************************************
Conditional liveness, separate from safety. Inputs eventually stabilize enabled;
all issued requests eventually resolve by application or rejection, so earlier
remote effects are finite. Rejection may lose its callback; local timeout and
admission are weakly fair. Expiry is weakly fair whenever the confirmed remote
value differs; this is weaker than unconditional fair periodic expiry and does
not use the oracle to guard an action. Ack/notice delivery need not be fair:
they may be lost. CapacityAdequate explicitly excludes runs whose needed repair
would exceed the finite request scope. This is not an unbounded retry proof.
Runs that stop expiring after convergence witness the premise without exhausting
capacity. The claim concerns actual remote value, not eventual acknowledgment.
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
The stored-name counterexample must actually deliver a superseded successful
outcome while display still equals the reverted goal. This witness prevents an
unrelated admission stall from counting as reproduction of the original race.
***************************************************************************)
StoredNameRepair == (<>s.staleDisplayOutcome) => Repair
=============================================================================
