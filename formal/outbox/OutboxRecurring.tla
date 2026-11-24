--------------------------- MODULE OutboxRecurring ---------------------------
(***************************************************************************)
(* Recurring issuance and its delivery outbox (core-ports 7.2, 7.3, J1-J4), *)
(* at sync commit 77a5bb7.                                                  *)
(*                                                                         *)
(* One schedule with autoSend, occurrences 1..N, all due. Recurring job    *)
(* executions run on Workers; each delivery has one workflow execution     *)
(* slot (DocumentDelivery keyed by the delivery id: a second start attaches *)
(* to a live execution, J1). Every action below is one transaction or one  *)
(* external call of the real code; the comments name it.                   *)
(*                                                                         *)
(* Paths are under packages/core/src/:                                      *)
(*   modules/recurring/issuance.ts   issue 239-312, send 315-359, run 363, *)
(*                                   pendingSends 393, sweep 410          *)
(*   modules/documents/deliveries/send.ts   insert queued row 210,         *)
(*                                   afterCommit(jobs.start) 242          *)
(*   modules/documents/deliveries/steps.ts  claim 67, dispatch 84,          *)
(*                                   record 122-143, giveUp 158, deliver 171 *)
(*   store/memory.ts   frames: afterCommit kept only on commit 162-168,     *)
(*                     drained after the outermost commit 180-197          *)
(*                                                                         *)
(* The guard flags are TRUE in the base config (the code at 77a5bb7); each  *)
(* mutant config turns guards off to show the properties can fail.         *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  N,            \* occurrences 1..N of the one schedule
  Workers,      \* recurring job executions that may run at once
  MaxCrashes,   \* process deaths
  CrashPoints,  \* where a process may die: "worker" (a recurring job, any step),
                \* or a delivery execution at "claim", "dispatch" (claimed, before
                \* the provider call: H3), "record" (after it), "giveup"
  MaxDupes,     \* extra (duplicate or stale) starts of an occurrence
  MaxSmtpFail,  \* provider failures (not accepted, unknown, rejected)
  MaxAttempts,  \* dispatch attempts per execution before giveUp
  \* guards of the real code (TRUE = present at 77a5bb7)
  LockSchedule,       \* issuance.ts:244/320 repo.lockSchedule row lock
  CasAdvance,         \* issuance.ts:303-307 updateSchedule(.., schedule.revision)
  UniqueLink,         \* issuance.ts:268-273 links.link, unique documents(schedule_id, occurrence)
  ReplayGuard,        \* issuance.ts:246-248 an issued run is returned, not re-issued
  StartAfterCommit,   \* send.ts:242 afterCommit(jobs.start), memory.ts:162-197
  DeliveryReconcile,  \* J1a OutboxReconcile for queued/sending deliveries (cron not in core)
  RecurringReconcile  \* issuance.ts:393 pendingSends, rerun `run` (J1a)

Occs == 1..N
NoOcc == 0
Terminal == {"sent", "failed"}

VARIABLES
  next,       \* schedules.next_occurrence (N+1 = none left)
  rev,        \* schedules.revision
  lock,       \* holder of the schedule row lock, or "free"
  docs,       \* docs[o]: documents issued for occurrence o
  run,        \* run[o]: schedule_runs row: "none" | "pending" | "queued" (send field)
  pc,         \* pc[w]: "idle" | "commit" | "send" | "hook"
  occ,        \* occ[w]: occurrence the execution works on
  seenIssued, seenNext, seenRev,  \* what the issue transaction read
  dstatus,    \* dstatus[o]: deliveries.status of o's delivery, "none" before insert
  dcount,     \* delivery rows inserted for o
  dpc,        \* DocumentDelivery execution of o: "none"|"claim"|"dispatch"|"record"|"giveup"|"done"|"dead"
  dout,       \* outcome of the in-flight provider call
  dtry,       \* failed dispatch attempts of the live execution
  smtp,       \* messages the provider accepted for o (duplicates allowed)
  started,    \* deliveries a DocumentDelivery start was issued for
  crashes, dupes, smtpFails

recVars == <<next, rev, lock, docs, run, pc, occ, seenIssued, seenNext, seenRev>>
delVars == <<dstatus, dcount, dpc, dout, dtry, smtp, started>>
budgets == <<crashes, dupes, smtpFails>>
vars == <<recVars, delVars, budgets>>

TypeOK ==
  /\ next \in 1..(N + 1)
  /\ rev \in Nat
  /\ lock \in Workers \cup {"free"}
  /\ docs \in [Occs -> Nat]
  /\ run \in [Occs -> {"none", "pending", "queued"}]
  /\ pc \in [Workers -> {"idle", "commit", "send", "hook"}]
  /\ occ \in [Workers -> Occs \cup {NoOcc}]
  /\ seenIssued \in [Workers -> BOOLEAN]
  /\ dstatus \in [Occs -> {"none", "queued", "sending", "sent", "failed"}]
  /\ dpc \in [Occs -> {"none", "claim", "dispatch", "record", "giveup", "done", "dead"}]
  /\ dout \in [Occs -> {"none", "ok", "not_accepted", "unknown", "rejected"}]
  /\ smtp \in [Occs -> Nat]
  /\ started \subseteq Occs

Init ==
  /\ next = 1 /\ rev = 1 /\ lock = "free"
  /\ docs = [o \in Occs |-> 0]
  /\ run = [o \in Occs |-> "none"]
  /\ pc = [w \in Workers |-> "idle"]
  /\ occ = [w \in Workers |-> NoOcc]
  /\ seenIssued = [w \in Workers |-> FALSE]
  /\ seenNext = [w \in Workers |-> 0]
  /\ seenRev = [w \in Workers |-> 0]
  /\ dstatus = [o \in Occs |-> "none"]
  /\ dcount = [o \in Occs |-> 0]
  /\ dpc = [o \in Occs |-> "none"]
  /\ dout = [o \in Occs |-> "none"]
  /\ dtry = [o \in Occs |-> 0]
  /\ smtp = [o \in Occs |-> 0]
  /\ started = {}
  /\ crashes = 0 /\ dupes = 0 /\ smtpFails = 0

LockFree == LockSchedule => lock = "free"
Release(w) == lock' = IF lock = w THEN "free" ELSE lock
ForgetRead(w) ==
  /\ seenIssued' = [seenIssued EXCEPT ![w] = FALSE]
  /\ seenNext' = [seenNext EXCEPT ![w] = 0]
  /\ seenRev' = [seenRev EXCEPT ![w] = 0]

(***************************************************************************)
(* Recurring job: issue transaction (issuance.ts:239-312). Begin = the     *)
(* transaction takes the schedule row lock (244) and reads the run (245)   *)
(* and the schedule (eligibility 250-253). Commit = the writes. With the    *)
(* lock held nothing changes in between, so Begin+Commit is the one real    *)
(* transaction; without the lock (mutant) the read can be stale.           *)
(***************************************************************************)
Begin(w, o) ==
  /\ pc[w] = "idle" /\ LockFree
  /\ lock' = IF LockSchedule THEN w ELSE lock
  /\ pc' = [pc EXCEPT ![w] = "commit"]
  /\ occ' = [occ EXCEPT ![w] = o]
  /\ seenIssued' = [seenIssued EXCEPT ![w] = run[o] # "none"]
  /\ seenNext' = [seenNext EXCEPT ![w] = next]
  /\ seenRev' = [seenRev EXCEPT ![w] = rev]

\* RecurringSweep tick (issuance.ts:410, sweep.ts decideDue): starts the
\* RecurringIssuance workflow for the schedule's next occurrence.
SweepStart(w) ==
  /\ next \in Occs
  /\ Begin(w, next)
  /\ UNCHANGED <<next, rev, docs, run, delVars, budgets>>

\* A duplicate or stale start (a workflow retry, a second sweep tick that
\* read an older next_occurrence, a concurrent run): any occurrence already
\* reached. Bounded by MaxDupes.
DupStart(w, o) ==
  /\ dupes < MaxDupes /\ o \in Occs /\ o <= next
  /\ Begin(w, o)
  /\ dupes' = dupes + 1
  /\ UNCHANGED <<next, rev, docs, run, delVars, crashes, smtpFails>>

\* OutboxReconcile -> RecurringIssuance.pendingSends (issuance.ts:393,
\* repo.ts pendingSendRuns): an issued run whose send is still pending is
\* rerun with `run` (it replays the issue and sends only).
ReconcileRecurring(w, o) ==
  /\ RecurringReconcile
  /\ run[o] = "pending"
  /\ Begin(w, o)
  /\ UNCHANGED <<next, rev, docs, run, delVars, budgets>>

IssueCommit(w) ==
  LET o == occ[w] IN
  /\ pc[w] = "commit"
  /\ Release(w)
  /\ IF seenIssued[w] /\ ReplayGuard
       \* 246-248: the issued run is returned (replayed); run goes on to send
       THEN /\ pc' = [pc EXCEPT ![w] = "send"]
            /\ UNCHANGED <<next, rev, docs, run>>
     ELSE IF o # seenNext[w]
       \* 250-253 issueEligibility: not the schedule's next occurrence: Skipped
       THEN /\ pc' = [pc EXCEPT ![w] = "idle"]
            /\ UNCHANGED <<next, rev, docs, run>>
     ELSE IF UniqueLink /\ docs[o] > 0
       \* 268-273: the link's unique index fails, dieOnUnique: rollback
       THEN /\ pc' = [pc EXCEPT ![w] = "idle"]
            /\ UNCHANGED <<next, rev, docs, run>>
     ELSE IF CasAdvance /\ rev # seenRev[w]
       \* 303-307: updateSchedule on a stale revision: Conflict, rollback
       THEN /\ pc' = [pc EXCEPT ![w] = "idle"]
            /\ UNCHANGED <<next, rev, docs, run>>
     ELSE \* 268-273 Documents.issue + link, 294-302 upsert run issued/send
          \* pending, 303-307 advance next_occurrence (occurrenceAfter) with CAS
          /\ docs' = [docs EXCEPT ![o] = @ + 1]
          /\ run' = [run EXCEPT ![o] = "pending"]
          /\ next' = o + 1
          /\ rev' = rev + 1
          /\ pc' = [pc EXCEPT ![w] = "send"]
  \* the read is used up: forget it (and the occurrence when the run ends)
  /\ occ' = [occ EXCEPT ![w] = IF pc'[w] = "idle" THEN NoOcc ELSE @]
  /\ ForgetRead(w)
  /\ UNCHANGED <<delVars, budgets>>

(***************************************************************************)
(* Recurring job: send transaction (issuance.ts:315-359), one transaction  *)
(* under the schedule lock (320). A pending run calls Documents.send as a   *)
(* savepoint (333): it inserts the queued delivery (send.ts:210) and        *)
(* registers afterCommit(jobs.start) (send.ts:242); then the run records    *)
(* send "queued" (351-355). A queued run replays (326-328).                *)
(***************************************************************************)
SendCommit(w) ==
  LET o == occ[w] IN
  /\ pc[w] = "send" /\ LockFree
  /\ IF run[o] = "pending"
       THEN /\ run' = [run EXCEPT ![o] = "queued"]
            /\ dstatus' = [dstatus EXCEPT ![o] = "queued"]
            /\ dcount' = [dcount EXCEPT ![o] = @ + 1]
            /\ IF StartAfterCommit
                 \* the hook waits in this process until it runs (Hook)
                 THEN /\ pc' = [pc EXCEPT ![w] = "hook"]
                      /\ UNCHANGED <<dpc, started>>
                 \* mutant: jobs.start runs inside the transaction
                 ELSE /\ pc' = [pc EXCEPT ![w] = "idle"]
                      /\ started' = started \cup {o}
                      /\ dpc' = [dpc EXCEPT ![o] = IF @ \in {"none", "dead", "done"} THEN "claim" ELSE @]
       ELSE /\ pc' = [pc EXCEPT ![w] = "idle"]
            /\ UNCHANGED <<run, dstatus, dcount, dpc, started>>
  /\ occ' = [occ EXCEPT ![w] = IF pc'[w] = "idle" THEN NoOcc ELSE @]
  /\ UNCHANGED <<next, rev, lock, docs, seenIssued, seenNext, seenRev,
                 dout, dtry, smtp, budgets>>

\* Mutant only: jobs.start ran inside the send transaction, then the
\* transaction rolled back (a crash before commit). The rows are gone; the
\* workflow start is not.
SendStartThenRollback(w) ==
  LET o == occ[w] IN
  /\ ~StartAfterCommit /\ "worker" \in CrashPoints
  /\ pc[w] = "send" /\ LockFree /\ run[o] = "pending"
  /\ crashes < MaxCrashes
  /\ crashes' = crashes + 1
  /\ pc' = [pc EXCEPT ![w] = "idle"]
  /\ started' = started \cup {o}
  /\ dpc' = [dpc EXCEPT ![o] = IF @ \in {"none", "dead", "done"} THEN "claim" ELSE @]
  /\ occ' = [occ EXCEPT ![w] = NoOcc]
  /\ UNCHANGED <<next, rev, lock, docs, run, seenIssued, seenNext, seenRev,
                 dstatus, dcount, dout, dtry, smtp, dupes, smtpFails>>

\* memory.ts:180-197 drainAfterCommit after the outermost commit: the
\* DeliveryJobs start, Workflow.execute keyed by the delivery id (jobs.ts:3).
\* A start for a live execution attaches to it.
Hook(w) ==
  LET o == occ[w] IN
  /\ pc[w] = "hook"
  /\ pc' = [pc EXCEPT ![w] = "idle"]
  /\ started' = started \cup {o}
  /\ dpc' = [dpc EXCEPT ![o] = IF @ \in {"none", "dead", "done"} THEN "claim" ELSE @]
  /\ occ' = [occ EXCEPT ![w] = NoOcc]
  /\ UNCHANGED <<next, rev, lock, docs, run, seenIssued, seenNext, seenRev,
                 dstatus, dcount, dout, dtry, smtp, budgets>>

\* The process running a recurring execution dies: the open transaction
\* rolls back (its lock goes), a pending afterCommit hook is lost.
CrashWorker(w) ==
  /\ "worker" \in CrashPoints
  /\ pc[w] \in {"commit", "send", "hook"}
  /\ crashes < MaxCrashes
  /\ crashes' = crashes + 1
  /\ pc' = [pc EXCEPT ![w] = "idle"]
  /\ Release(w)
  /\ occ' = [occ EXCEPT ![w] = NoOcc]
  /\ ForgetRead(w)
  /\ UNCHANGED <<next, rev, docs, run, delVars, dupes, smtpFails>>

(***************************************************************************)
(* DocumentDelivery execution of o's delivery: deliver = claim then        *)
(* dispatch (steps.ts:171), retries, giveUp.                              *)
(***************************************************************************)
\* steps.ts:67-81 claim: one transaction under the row lock. queued ->
\* sending (J3 eligibility holds in this model); a sending row stays
\* sending and is dispatched again (73: only queued is changed, deliver
\* dispatches any non-terminal status); a terminal row ends the execution.
Claim(o) ==
  /\ dpc[o] = "claim"
  /\ IF dstatus[o] = "queued"
       THEN /\ dstatus' = [dstatus EXCEPT ![o] = "sending"]
            /\ dpc' = [dpc EXCEPT ![o] = "dispatch"]
     ELSE IF dstatus[o] = "sending"
       THEN /\ dpc' = [dpc EXCEPT ![o] = "dispatch"]
            /\ UNCHANGED dstatus
     ELSE /\ dpc' = [dpc EXCEPT ![o] = "done"]   \* terminal, or NotFound
          /\ UNCHANGED dstatus
  /\ UNCHANGED <<recVars, dcount, dout, dtry, smtp, started, budgets>>

\* steps.ts:84-118 dispatch: reads the row (87); not sending -> returns;
\* else EmailSender.send with idempotencyKey = delivery id (115). The
\* provider accepts (ok), does not take it (not_accepted), rejects it, or
\* times out after accepting it (unknown, counted as sent: worst case).
Dispatch(o, out) ==
  /\ dpc[o] = "dispatch"
  /\ IF dstatus[o] # "sending"
       THEN /\ dpc' = [dpc EXCEPT ![o] = "done"]
            /\ UNCHANGED <<dout, smtp, smtpFails>>
       ELSE /\ out = "ok" \/ smtpFails < MaxSmtpFail
            /\ smtpFails' = IF out = "ok" THEN smtpFails ELSE smtpFails + 1
            /\ smtp' = [smtp EXCEPT ![o] = IF out \in {"ok", "unknown"} THEN @ + 1 ELSE @]
            /\ dout' = [dout EXCEPT ![o] = out]
            /\ dpc' = [dpc EXCEPT ![o] = "record"]
  /\ UNCHANGED <<recVars, dstatus, dcount, dtry, started, crashes, dupes>>

\* steps.ts:122-154: the record transaction. Success -> sent (also over a
\* failed row); rejected -> failed; not_accepted/unknown leave it sending
\* and DeliveryRetry makes the Activity retry dispatch, or giveUp.
Record(o) ==
  /\ dpc[o] = "record"
  /\ dout' = [dout EXCEPT ![o] = "none"]
  /\ IF dout[o] = "ok"
       THEN /\ dstatus' = [dstatus EXCEPT ![o] = "sent"]
            /\ dpc' = [dpc EXCEPT ![o] = "done"]
            /\ dtry' = [dtry EXCEPT ![o] = 0]
     ELSE IF dstatus[o] # "sending"
       THEN /\ dpc' = [dpc EXCEPT ![o] = "done"] /\ dtry' = [dtry EXCEPT ![o] = 0]
            /\ UNCHANGED dstatus
     ELSE IF dout[o] = "rejected"
       THEN /\ dstatus' = [dstatus EXCEPT ![o] = "failed"]
            /\ dpc' = [dpc EXCEPT ![o] = "done"]
            /\ UNCHANGED dtry
     ELSE /\ dtry' = [dtry EXCEPT ![o] = @ + 1]
          /\ dpc' = [dpc EXCEPT ![o] = IF dtry[o] + 1 < MaxAttempts THEN "dispatch" ELSE "giveup"]
          /\ UNCHANGED dstatus
  /\ UNCHANGED <<recVars, dcount, smtp, started, budgets>>

\* steps.ts:158-168 giveUp: sending -> failed once retries are exhausted.
GiveUp(o) ==
  /\ dpc[o] = "giveup"
  /\ dstatus' = [dstatus EXCEPT ![o] = IF @ = "sending" THEN "failed" ELSE @]
  /\ dpc' = [dpc EXCEPT ![o] = "done"]
  /\ dtry' = [dtry EXCEPT ![o] = 0]
  /\ UNCHANGED <<recVars, dcount, dout, smtp, started, budgets>>

\* The process running the delivery execution dies. "dispatch" is the H3
\* point (claimed sending, no provider call yet); "record" is after the
\* provider call, before its outcome is stored.
CrashDelivery(o) ==
  /\ dpc[o] \in {"claim", "dispatch", "record", "giveup"} \cap CrashPoints
  /\ crashes < MaxCrashes
  /\ crashes' = crashes + 1
  /\ dpc' = [dpc EXCEPT ![o] = "dead"]
  /\ dout' = [dout EXCEPT ![o] = "none"]
  /\ dtry' = [dtry EXCEPT ![o] = 0]
  /\ UNCHANGED <<recVars, dstatus, dcount, smtp, started, dupes, smtpFails>>

\* J1a OutboxReconcile (core-ports 1296-1297, 1419-1424): a queued or
\* sending delivery whose execution is not live is re-executed with the same
\* key, whatever workflow_started_at says. The selection query is not in
\* core at 77a5bb7 (see the skill); the restarted body is steps.ts deliver.
ReconcileDelivery(o) ==
  /\ DeliveryReconcile
  /\ dstatus[o] \in {"queued", "sending"}
  /\ dpc[o] \in {"none", "dead", "done"}
  /\ dpc' = [dpc EXCEPT ![o] = "claim"]
  /\ dtry' = [dtry EXCEPT ![o] = 0]
  /\ started' = started \cup {o}
  /\ UNCHANGED <<recVars, dstatus, dcount, dout, smtp, budgets>>

\* Every occurrence issued and every delivery terminal, nothing in flight.
Done ==
  /\ next = N + 1
  /\ \A w \in Workers : pc[w] = "idle"
  /\ \A o \in Occs : dstatus[o] \in Terminal /\ dpc[o] \in {"none", "done", "dead"}
  /\ UNCHANGED vars

Next ==
  \/ \E w \in Workers :
       \/ SweepStart(w) \/ IssueCommit(w) \/ SendCommit(w) \/ SendStartThenRollback(w)
       \/ Hook(w) \/ CrashWorker(w)
       \/ \E o \in Occs : DupStart(w, o) \/ ReconcileRecurring(w, o)
  \/ \E o \in Occs :
       \/ Claim(o) \/ Record(o) \/ GiveUp(o) \/ CrashDelivery(o) \/ ReconcileDelivery(o)
       \/ \E out \in {"ok", "not_accepted", "unknown", "rejected"} : Dispatch(o, out)
  \/ Done

\* One delivery execution's steps.
DeliveryStep(o) ==
  \/ Claim(o) \/ Record(o) \/ GiveUp(o)
  \/ \E out \in {"ok", "not_accepted", "unknown", "rejected"} : Dispatch(o, out)

\* Fairness per component that runs on its own in production: the
\* RecurringSweep cron, the OutboxReconcile cron (both halves), each
\* recurring job execution and each delivery execution. Crashes, duplicate
\* starts and provider failures get none (and are bounded). A lock wait
\* makes a start or the send transaction flicker between enabled and not,
\* so those get strong fairness; the rest weak.
Fairness ==
  /\ SF_vars(\E w \in Workers : SweepStart(w))
  /\ SF_vars(\E w \in Workers, o \in Occs : ReconcileRecurring(w, o))
  /\ WF_vars(\E o \in Occs : ReconcileDelivery(o))
  /\ \A w \in Workers : WF_vars(IssueCommit(w) \/ Hook(w)) /\ SF_vars(SendCommit(w))
  /\ \A o \in Occs : WF_vars(DeliveryStep(o))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Safety *)

\* Exactly one document per (schedule, occurrence).
OneDocumentPerOccurrence == \A o \in Occs : docs[o] <= 1

\* next_occurrence moves by CAS one occurrence per issue: the occurrences
\* before it are exactly the issued ones.
NextFollowsIssued == \A o \in Occs : (o < next) <=> (docs[o] = 1)

\* One delivery row per occurrence's send; a run is queued iff its row exists.
OneDeliveryPerOccurrence ==
  \A o \in Occs : dcount[o] <= 1 /\ ((run[o] = "queued") <=> (dstatus[o] # "none"))

\* A DocumentDelivery start is only ever issued for a committed delivery row.
StartedOnlyCommitted == \A o \in started : dstatus[o] # "none"

\* A delivery is marked sent only after the provider accepted it.
SentImpliesAccepted == \A o \in Occs : dstatus[o] = "sent" => smtp[o] >= 1

(* Liveness, under Fairness and the crash / failure budgets *)

\* Every due occurrence gets its document.
EveryOccurrenceIssued == <>(\A o \in Occs : docs[o] = 1)

\* No lost send: every occurrence's email ends sent (at least once; the
\* provider may have it twice) or failed after a rejection or giveUp.
NoLostSend == \A o \in Occs : <>(dstatus[o] \in Terminal)
=============================================================================
