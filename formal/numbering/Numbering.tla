------------------------------ MODULE Numbering ------------------------------
(***************************************************************************)
(* Gapless document numbering (core-ports D1, S3, S4) with number          *)
(* overrides (D4), for one Workspace, one DocumentKind and one Numbering   *)
(* Series with a period in its pattern (YYYY-NNNN: one counter per year).  *)
(*                                                                         *)
(* Steps are SQL statements under Postgres READ COMMITTED on the committed *)
(* schema (packages/db/drizzle/20261123175822_init/migration.sql). The     *)
(* in-memory store runs each top-level transaction alone                   *)
(* (packages/core/src/store/memory.ts:4) and has no foreign keys, so its   *)
(* behaviours are serial runs of this model with the foreign-key check     *)
(* passing; the replay harness (numbering.replay.test.ts) drives those on  *)
(* the real Documents service.                                             *)
(*                                                                         *)
(* Issue (Documents.issue, packages/core/src/modules/documents/            *)
(*   lifecycle.ts:143-200 -> numbered:89 -> NumberingSeries.allocate,      *)
(*   numbering/service.ts:353-381):                                        *)
(*   IDocLock repo.lock(draft) + revision check (lifecycle.ts:163); an     *)
(*            issue from input has no row yet and locks nothing            *)
(*   ILock    store.counters.lock(key)  service.ts:361 (FOR UPDATE)        *)
(*   ITry     format + reservations.tryReserve service.ts:362-376; taken   *)
(*            -> sequence++; past MAX_COUNTER -> exhausted. For an issue   *)
(*            from input the document row does not exist yet, so a free    *)
(*            key fails number_reservations_document_fk (migration.sql:926,*)
(*            SQLSTATE 23503) and the transaction aborts                   *)
(*   ISet     store.counters.set(key, seq + 1) service.ts:377              *)
(*   IWrite   repo.update (draft) / repo.insert (input) with the number;   *)
(*            documents unique index NUMBER_PER_KIND (record.ts:236) ->    *)
(*            Conflict{duplicate} (lifecycle.ts:178, 194)                  *)
(*   ICommit  commit (the document's revision grows)                       *)
(* Override (Documents.edit, documents/service.ts:46-60 -> editIssued,     *)
(*   lifecycle.ts:389-480 -> NumberingSeries.override, service.ts:383-395):*)
(*   OStart   the client reads the document and sends its revision         *)
(*   OLock    repo.getForUpdate(id, expectedRevision): waits on the row    *)
(*            lock, then a changed revision -> Conflict{revision_changed}; *)
(*            a draft -> illegal; the same number -> no override           *)
(*   OReserve reservations.tryReserve(new number); taken -> Conflict       *)
(*   OUpdate  repo.update with the new number (unique index, line 479)     *)
(*   OCommit  commit; the old number's reservation stays (insert-only)     *)
(* Crash: a transaction that is not waiting rolls back (all its writes and *)
(* its counter value revert, locks are released). A waiting transaction    *)
(* cannot crash, so a wait cycle is a deadlock TLC reports.                *)
(*                                                                         *)
(* tryReserve is INSERT ... ON CONFLICT DO NOTHING on the primary key      *)
(* number_reservations(workspace_id, kind, number): a key another open     *)
(* transaction inserted makes the statement wait for that transaction;     *)
(* then it inserts (the other rolled back) or reports taken (committed).   *)
(* A conflicting key inserts no row, so no foreign key is checked.         *)
(*                                                                         *)
(* Mutant switch (one spec, constant-selected):                            *)
(*   "none"                      the code as written                       *)
(*   "no_reservation"            allocate uses the counter without          *)
(*                               tryReserve (no reservation, no skip)      *)
(*   "counter_kept_on_rollback"  counters.set survives a rollback          *)
(*   "release_old_number"        an override frees the old number          *)
(*   "override_moves_counter"    an override raises the series counter     *)
(*   "rollback_keeps_reservation" a rollback leaves its reservations        *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Issuers,       \* issue transactions; issuer i numbers document i
    DraftIssuers,  \* issuers whose document is a stored draft; the rest issue from input
    Overriders,    \* number-override transactions (Documents.edit with patch.number)
    Periods,       \* counter periods (years)
    MaxSeq,        \* Numbering.MAX_COUNTER at model scale
    D0,            \* a document issued before the run, number <<P0, 1>>
    P0,            \* the period of D0
    None,
    Mutant

ASSUME DraftIssuers \subseteq Issuers
ASSUME P0 \in Periods /\ MaxSeq \in Nat \ {0}
ASSUME Mutant \in {"none", "no_reservation", "counter_kept_on_rollback",
                   "release_old_number", "override_moves_counter",
                   "rollback_keeps_reservation"}

Txs  == Issuers \cup Overriders
Docs == {D0} \cup Issuers
Nums == Periods \X (1..MaxSeq)
Free == "free"
Committed == "committed"
MaxRev == 2 + Cardinality(Overriders)

VARIABLES
    pc,        \* per transaction: its next statement
    per,       \* issuer: the period of its issue date
    seq,       \* issuer: the candidate sequence
    saved,     \* issuer: counter value read by counters.lock (rollback image)
    tgt,       \* overrider: the requested number
    od,        \* overrider: the document it edits
    seen,      \* overrider: the revision the client sent (expectedRevision)
    old,       \* overrider: the document's number when locked
    outcome,   \* per transaction: how it ended
    counter,   \* numbering_counters.next_counter per period (as seen by its lock holder)
    ctrLock,   \* counter row lock holder per period
    resv,      \* number_reservations per number: Free, Committed, or the open owner tx
    exists,    \* committed documents rows
    docNum,    \* committed documents.number per document
    docRev,    \* committed documents.revision per document
    pend,      \* uncommitted documents.number written by an open transaction
    docLock,   \* document row lock holder
    held,      \* history: documents that ever committed with each number
    allocated  \* history: numbers committed by issue transactions

vars == <<pc, per, seq, saved, tgt, od, seen, old, outcome, counter, ctrLock,
          resv, exists, docNum, docRev, pend, docLock, held, allocated>>

Outcomes == {"open", "committed", "aborted", "conflict", "exhausted", "illegal",
             "unchanged", "revision_changed", "fk_violation"}

TypeOK ==
    /\ pc \in [Txs -> {"start", "lockdoc", "lock", "try", "set", "write",
                       "commit", "reserve", "update", "done"}]
    /\ per \in [Txs -> Periods \cup {None}]
    /\ seq \in [Txs -> 0..(MaxSeq + 1)]
    /\ saved \in [Txs -> 0..(MaxSeq + 1)]
    /\ tgt \in [Txs -> Nums \cup {None}]
    /\ od \in [Txs -> Docs \cup {None}]
    /\ seen \in [Txs -> 0..MaxRev]
    /\ old \in [Txs -> Nums \cup {None}]
    /\ outcome \in [Txs -> Outcomes]
    /\ counter \in [Periods -> 1..(MaxSeq + 1)]
    /\ ctrLock \in [Periods -> Txs \cup {None}]
    /\ resv \in [Nums -> Txs \cup {Free, Committed}]
    /\ exists \in [Docs -> BOOLEAN]
    /\ docNum \in [Docs -> Nums \cup {None}]
    /\ docRev \in [Docs -> 0..MaxRev]
    /\ pend \in [Txs -> Nums \cup {None}]
    /\ docLock \in [Docs -> Txs \cup {None}]
    /\ held \in [Nums -> SUBSET Docs]
    /\ allocated \in SUBSET Nums

Init ==
    /\ pc = [t \in Txs |-> "start"]
    /\ per = [t \in Txs |-> None]
    /\ seq = [t \in Txs |-> 0]
    /\ saved = [t \in Txs |-> 0]
    /\ tgt = [t \in Txs |-> None]
    /\ od = [t \in Txs |-> None]
    /\ seen = [t \in Txs |-> 0]
    /\ old = [t \in Txs |-> None]
    /\ outcome = [t \in Txs |-> "open"]
    /\ counter = [p \in Periods |-> IF p = P0 THEN 2 ELSE 1]
    /\ ctrLock = [p \in Periods |-> None]
    /\ resv = [n \in Nums |-> IF n = <<P0, 1>> THEN Committed ELSE Free]
    /\ exists = [d \in Docs |-> d = D0 \/ d \in DraftIssuers]
    /\ docNum = [d \in Docs |-> IF d = D0 THEN <<P0, 1>> ELSE None]
    /\ docRev = [d \in Docs |-> IF d = D0 \/ d \in DraftIssuers THEN 1 ELSE 0]
    /\ pend = [t \in Txs |-> None]
    /\ docLock = [d \in Docs |-> None]
    /\ held = [n \in Nums |-> IF n = <<P0, 1>> THEN {D0} ELSE {}]
    /\ allocated = {<<P0, 1>>}

(* Another open transaction has written number n to a document. *)
PendingElsewhere(t, n) == \E u \in Txs \ {t} : pend[u] = n
(* A committed document other than d carries n. *)
CommittedElsewhere(d, n) == \E e \in Docs \ {d} : docNum[e] = n
(* The key n is held by another open transaction. *)
OpenElsewhere(t, n) == resv[n] \in Txs \ {t}

(* t is waiting for a lock or key another open transaction holds. *)
Waiting(t) ==
    \/ pc[t] = "lockdoc" /\ docLock[t] # None
    \/ pc[t] = "lock" /\ t \in Issuers /\ ctrLock[per[t]] # None
    \/ pc[t] = "try" /\ seq[t] <= MaxSeq /\ Mutant # "no_reservation"
         /\ OpenElsewhere(t, <<per[t], seq[t]>>)
    \/ pc[t] = "write" /\ ~CommittedElsewhere(t, <<per[t], seq[t]>>)
         /\ PendingElsewhere(t, <<per[t], seq[t]>>)
    \/ pc[t] = "lock" /\ t \in Overriders /\ docLock[od[t]] # None
    \/ pc[t] = "reserve" /\ OpenElsewhere(t, tgt[t])
    \/ pc[t] = "update" /\ ~CommittedElsewhere(od[t], tgt[t])
         /\ PendingElsewhere(t, tgt[t])

(* Rollback of t, ending with outcome why. *)
Rollback(t, why) ==
    /\ resv' = [n \in Nums |->
                  IF resv[n] = t
                  THEN IF Mutant = "rollback_keeps_reservation" THEN Committed ELSE Free
                  ELSE resv[n]]
    /\ counter' = [p \in Periods |->
                     IF ctrLock[p] = t /\ Mutant # "counter_kept_on_rollback"
                     THEN saved[t] ELSE counter[p]]
    /\ ctrLock' = [p \in Periods |-> IF ctrLock[p] = t THEN None ELSE ctrLock[p]]
    /\ docLock' = [d \in Docs |-> IF docLock[d] = t THEN None ELSE docLock[d]]
    /\ pend' = [pend EXCEPT ![t] = None]
    /\ pc' = [pc EXCEPT ![t] = "done"]
    /\ outcome' = [outcome EXCEPT ![t] = why]
    /\ UNCHANGED <<per, seq, saved, tgt, od, seen, old, exists, docNum, docRev,
                   held, allocated>>

(* ---------------------------- issue ---------------------------------- *)

IStart(t) ==
    /\ pc[t] = "start"
    /\ \E p \in Periods :
         /\ per' = [per EXCEPT ![t] = p]
         /\ pc' = [pc EXCEPT ![t] = IF t \in DraftIssuers THEN "lockdoc" ELSE "lock"]
    /\ UNCHANGED <<seq, saved, tgt, od, seen, old, outcome, counter, ctrLock, resv,
                   exists, docNum, docRev, pend, docLock, held, allocated>>

IDocLock(t) ==
    /\ pc[t] = "lockdoc"
    /\ docLock[t] = None
    /\ docLock' = [docLock EXCEPT ![t] = t]
    /\ pc' = [pc EXCEPT ![t] = "lock"]
    /\ UNCHANGED <<per, seq, saved, tgt, od, seen, old, outcome, counter, ctrLock,
                   resv, exists, docNum, docRev, pend, held, allocated>>

ILock(t) ==
    /\ pc[t] = "lock"
    /\ ctrLock[per[t]] = None
    /\ ctrLock' = [ctrLock EXCEPT ![per[t]] = t]
    /\ seq' = [seq EXCEPT ![t] = counter[per[t]]]
    /\ saved' = [saved EXCEPT ![t] = counter[per[t]]]
    /\ pc' = [pc EXCEPT ![t] = "try"]
    /\ UNCHANGED <<per, tgt, od, seen, old, outcome, counter, resv, exists,
                   docNum, docRev, pend, docLock, held, allocated>>

ITry(t) ==
    /\ pc[t] = "try"
    /\ IF seq[t] > MaxSeq
       THEN Rollback(t, "exhausted")
       ELSE LET n == <<per[t], seq[t]>> IN
            IF Mutant = "no_reservation"
            THEN /\ pc' = [pc EXCEPT ![t] = "set"]
                 /\ UNCHANGED <<per, seq, saved, tgt, od, seen, old, outcome,
                                counter, ctrLock, resv, exists, docNum, docRev,
                                pend, docLock, held, allocated>>
            ELSE IF resv[n] = Free /\ ~exists[t]
            THEN Rollback(t, "fk_violation")   \* no documents row to reference yet
            ELSE IF resv[n] = Free
            THEN /\ resv' = [resv EXCEPT ![n] = t]
                 /\ pc' = [pc EXCEPT ![t] = "set"]
                 /\ UNCHANGED <<per, seq, saved, tgt, od, seen, old, outcome,
                                counter, ctrLock, exists, docNum, docRev, pend,
                                docLock, held, allocated>>
            ELSE IF resv[n] = Committed
            THEN /\ seq' = [seq EXCEPT ![t] = seq[t] + 1]
                 /\ UNCHANGED <<pc, per, saved, tgt, od, seen, old, outcome,
                                counter, ctrLock, resv, exists, docNum, docRev,
                                pend, docLock, held, allocated>>
            ELSE FALSE  \* another open transaction holds the key: wait

ISet(t) ==
    /\ pc[t] = "set"
    /\ counter' = [counter EXCEPT ![per[t]] = seq[t] + 1]
    /\ pc' = [pc EXCEPT ![t] = "write"]
    /\ UNCHANGED <<per, seq, saved, tgt, od, seen, old, outcome, ctrLock, resv,
                   exists, docNum, docRev, pend, docLock, held, allocated>>

IWrite(t) ==
    /\ pc[t] = "write"
    /\ LET n == <<per[t], seq[t]>> IN
       IF CommittedElsewhere(t, n)
       THEN Rollback(t, "conflict")
       ELSE /\ ~PendingElsewhere(t, n)  \* unique index waits on an open writer
            /\ pend' = [pend EXCEPT ![t] = n]
            /\ pc' = [pc EXCEPT ![t] = "commit"]
            /\ UNCHANGED <<per, seq, saved, tgt, od, seen, old, outcome, counter,
                           ctrLock, resv, exists, docNum, docRev, docLock, held,
                           allocated>>

ICommit(t) ==
    /\ pc[t] = "commit"
    /\ LET n == pend[t] IN
       /\ resv' = [m \in Nums |-> IF resv[m] = t THEN Committed ELSE resv[m]]
       /\ docNum' = [docNum EXCEPT ![t] = n]
       /\ held' = [held EXCEPT ![n] = @ \cup {t}]
       /\ allocated' = allocated \cup {n}
    /\ exists' = [exists EXCEPT ![t] = TRUE]
    /\ docRev' = [docRev EXCEPT ![t] = @ + 1]
    /\ ctrLock' = [ctrLock EXCEPT ![per[t]] = None]
    /\ docLock' = [d \in Docs |-> IF docLock[d] = t THEN None ELSE docLock[d]]
    /\ pend' = [pend EXCEPT ![t] = None]
    /\ pc' = [pc EXCEPT ![t] = "done"]
    /\ outcome' = [outcome EXCEPT ![t] = "committed"]
    /\ UNCHANGED <<per, seq, saved, tgt, od, seen, old, counter>>

(* --------------------------- override -------------------------------- *)

OStart(o) ==
    /\ pc[o] = "start"
    /\ \E d \in {e \in Docs : exists[e]}, n \in Nums :
         /\ od' = [od EXCEPT ![o] = d]
         /\ tgt' = [tgt EXCEPT ![o] = n]
         /\ seen' = [seen EXCEPT ![o] = docRev[d]]
         /\ pc' = [pc EXCEPT ![o] = "lock"]
    /\ UNCHANGED <<per, seq, saved, old, outcome, counter, ctrLock, resv, exists,
                   docNum, docRev, pend, docLock, held, allocated>>

OLock(o) ==
    /\ pc[o] = "lock"
    /\ docLock[od[o]] = None
    /\ IF docRev[od[o]] # seen[o]
       THEN Rollback(o, "revision_changed")
       ELSE IF docNum[od[o]] = None
       THEN Rollback(o, "illegal")          \* a draft: D4 refuses
       ELSE IF docNum[od[o]] = tgt[o]
       THEN Rollback(o, "unchanged")        \* same number: no override
       ELSE /\ docLock' = [docLock EXCEPT ![od[o]] = o]
            /\ old' = [old EXCEPT ![o] = docNum[od[o]]]
            /\ pc' = [pc EXCEPT ![o] = "reserve"]
            /\ UNCHANGED <<per, seq, saved, tgt, od, seen, outcome, counter,
                           ctrLock, resv, exists, docNum, docRev, pend, held,
                           allocated>>

OReserve(o) ==
    /\ pc[o] = "reserve"
    /\ LET n == tgt[o] IN
       IF resv[n] = Free
       THEN /\ resv' = [resv EXCEPT ![n] = o]
            /\ pc' = [pc EXCEPT ![o] = "update"]
            /\ UNCHANGED <<per, seq, saved, tgt, od, seen, old, outcome, counter,
                           ctrLock, exists, docNum, docRev, pend, docLock, held,
                           allocated>>
       ELSE IF resv[n] = Committed
       THEN Rollback(o, "conflict")
       ELSE FALSE                           \* open owner: wait

OUpdate(o) ==
    /\ pc[o] = "update"
    /\ LET n == tgt[o] IN
       IF CommittedElsewhere(od[o], n)
       THEN Rollback(o, "conflict")
       ELSE /\ ~PendingElsewhere(o, n)
            /\ pend' = [pend EXCEPT ![o] = n]
            /\ pc' = [pc EXCEPT ![o] = "commit"]
            /\ UNCHANGED <<per, seq, saved, tgt, od, seen, old, outcome, counter,
                           ctrLock, resv, exists, docNum, docRev, docLock, held,
                           allocated>>

OCommit(o) ==
    /\ pc[o] = "commit"
    /\ LET n == pend[o]
           p == n[1]
       IN
       /\ resv' = [m \in Nums |->
                     IF resv[m] = o THEN Committed
                     ELSE IF m = old[o] /\ Mutant = "release_old_number" THEN Free
                     ELSE resv[m]]
       /\ docNum' = [docNum EXCEPT ![od[o]] = n]
       /\ held' = [held EXCEPT ![n] = @ \cup {od[o]}]
       /\ IF Mutant = "override_moves_counter"
          THEN counter' = [counter EXCEPT ![p] = IF n[2] + 1 > @ THEN n[2] + 1 ELSE @]
          ELSE UNCHANGED counter
    /\ docRev' = [docRev EXCEPT ![od[o]] = @ + 1]
    /\ docLock' = [docLock EXCEPT ![od[o]] = None]
    /\ pend' = [pend EXCEPT ![o] = None]
    /\ pc' = [pc EXCEPT ![o] = "done"]
    /\ outcome' = [outcome EXCEPT ![o] = "committed"]
    /\ UNCHANGED <<per, seq, saved, tgt, od, seen, old, ctrLock, exists, allocated>>

(* ---------------------------- crash ---------------------------------- *)

Crash(t) ==
    /\ pc[t] \notin {"start", "done"}
    /\ ~Waiting(t)
    /\ Rollback(t, "aborted")

Terminated == \A t \in Txs : pc[t] = "done"

Next ==
    \/ \E t \in Issuers : IStart(t) \/ IDocLock(t) \/ ILock(t) \/ ITry(t)
                          \/ ISet(t) \/ IWrite(t) \/ ICommit(t)
    \/ \E o \in Overriders : OStart(o) \/ OLock(o) \/ OReserve(o) \/ OUpdate(o)
                             \/ OCommit(o)
    \/ \E t \in Txs : Crash(t)
    \/ (Terminated /\ UNCHANGED vars)

Spec == Init /\ [][Next]_vars

(* ---------------------------- properties ----------------------------- *)

(* The counter value other transactions see: the lock holder's write is not committed. *)
CommittedCounter(p) ==
    IF ctrLock[p] \in Issuers THEN saved[ctrLock[p]] ELSE counter[p]

MaxOf(S) == CHOOSE m \in S : \A s \in S : s <= m

(* No two issued documents share a number (per Workspace and kind). *)
NoDuplicateNumber ==
    \A d, e \in Docs :
        (d # e /\ docNum[d] # None) => docNum[d] # docNum[e]

(* A number is never given to a second document, even after an override moved the first. *)
NoReuse == \A n \in Nums : Cardinality(held[n]) <= 1

(* Every number a document ever carried stays reserved (D1, D4: insert-only reservations). *)
ReservedForever == \A n \in Nums : held[n] # {} => resv[n] = Committed

(* Every sequence below the committed counter is reserved: allocation leaves no gap (S3). *)
Gapless ==
    \A p \in Periods :
        \A s \in 1..(CommittedCounter(p) - 1) : resv[<<p, s>>] = Committed

(* The committed counter is one past the last sequence an issue allocated (D4: overrides
   do not move it; S3: a rollback reverts it). *)
CounterTracksIssue ==
    \A p \in Periods :
        CommittedCounter(p) = 1 + MaxOf({n[2] : n \in {m \in allocated : m[1] = p}} \cup {0})

(* Every committed reservation belongs to a number some document carried: a rollback
   leaves no orphan reservation (S3), so every reserved number below the counter is a
   number a document was issued with or overridden to. *)
NoOrphanReservation == \A n \in Nums : resv[n] = Committed => held[n] # {}

(* The allocator never offers an issue a number another document carries, so the
   documents NUMBER_PER_KIND index never has to reject an issue. *)
IssueNeverHitsIndex == \A t \in Issuers : outcome[t] # "conflict"

(* An override step never changes a counter (D4). *)
OverrideKeepsCounter ==
    [][(\E o \in Overriders : pc'[o] # pc[o]) => counter' = counter]_vars

=============================================================================
