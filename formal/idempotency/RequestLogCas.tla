--------------------------- MODULE RequestLogCas ---------------------------
(***************************************************************************)
(* Request-key retry safety (rule C3) and the optimistic revision check   *)
(* (rule C2), as packages/core/src/shared/idempotency.ts (withIdempotency) *)
(* runs them over the CoreStore port (packages/core/src/store/CoreStore.ts *)
(* requestLog.claim/complete, Collection.getForUpdate/update in            *)
(* store/tables.ts) for one Contact row edited by Contacts.save            *)
(* (packages/core/src/modules/contacts/live.ts, save -> edit/create).      *)
(*                                                                         *)
(* Each process is one attempt of one request: a client that times out or *)
(* loses the reply sends the same request again with the same requestKey, *)
(* and the attempts may overlap.                                           *)
(*                                                                         *)
(* Atomic steps, one per code step that another transaction can observe:  *)
(*   Claim    store.transaction opens and requestLog.claim runs: a live    *)
(*            entry is Existing, a free key is Claimed (pending), a key    *)
(*            pending in another transaction waits (CoreStore.ts claim).   *)
(*   Existing the method + fingerprint compare and the replay              *)
(*            (idempotency.ts lines 65-76).                                *)
(*   Lock     getForUpdate row-locks and checks expectedRevision           *)
(*            (contacts/live.ts edit; memory.ts locate); a stale revision  *)
(*            fails the body, so the transaction rolls back.               *)
(*   Commit   repo.update (compare-and-set to revision + 1) or repo.insert,*)
(*            the audit row, requestLog.complete and COMMIT. Everything   *)
(*            before COMMIT is transaction-local and invisible to others, *)
(*            so it is one step; Abort before it undoes all of it.         *)
(*   Abort    any failure, defect or interruption in the body rolls back:  *)
(*            the pending claim and the row lock go (memory.ts runFrame).  *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Attempts,  \* attempts (first try + retries) per request
  Bug        \* "none" in the base; a mutant config names the broken step

(* The requests. r1 and r2 reuse one requestKey with different payloads   *)
(* (a client bug or a replayed key: must be idempotency_mismatch). r3 is a *)
(* competing edit of the same row from the same revision (one must get    *)
(* revision_changed). r4 creates a Contact: no revision guards it, only   *)
(* the claim does.                                                         *)
Req == <<
  [key |-> "k1", payload |-> "A", op |-> "edit",   expected |-> 1],
  [key |-> "k1", payload |-> "B", op |-> "edit",   expected |-> 1],
  [key |-> "k2", payload |-> "C", op |-> "edit",   expected |-> 1],
  [key |-> "k3", payload |-> "D", op |-> "create", expected |-> 0] >>

R == 1..Len(Req)
Procs == R \X (1..Attempts)
Keys == {Req[r].key : r \in R}
NoProc == <<0, 0>>
KeyOf(p) == Req[p[1]].key

FreeLog == [tag |-> "free", owner |-> NoProc, payload |-> "", result |-> 0]
NoReply == [kind |-> "none", result |-> 0]

VARIABLES
  pc,       \* attempt step: idle, existing, lock, body, done
  log,      \* request_log row per key: free, pending(owner) or a committed entry
  rowRev,   \* committed revision of the Contact row
  rowLock,  \* attempt holding the row lock (getForUpdate), or NoProc
  history,  \* committed edits, in commit order: [req, base] (base = revision the edit was made from)
  inserts,  \* committed creates per key
  reply     \* what each attempt returned to its client

vars == <<pc, log, rowRev, rowLock, history, inserts, reply>>

Init ==
  /\ pc = [p \in Procs |-> "idle"]
  /\ log = [k \in Keys |-> FreeLog]
  /\ rowRev = 1
  /\ rowLock = NoProc
  /\ history = <<>>
  /\ inserts = [k \in Keys |-> 0]
  /\ reply = [p \in Procs |-> NoReply]

(* Rollback of attempt p: drop its pending claim and its row lock. *)
Rollback(p) ==
  /\ log' = IF log[KeyOf(p)].tag = "pending" /\ log[KeyOf(p)].owner = p
                 /\ Bug # "keep_claim_on_rollback"
              THEN [log EXCEPT ![KeyOf(p)] = FreeLog]
              ELSE log
  /\ rowLock' = IF rowLock = p THEN NoProc ELSE rowLock

Claim(p) ==
  LET k == KeyOf(p) IN
  /\ pc[p] = "idle"
  /\ \/ /\ log[k].tag = "entry"
        /\ pc' = [pc EXCEPT ![p] = "existing"]
        /\ UNCHANGED log
     \/ /\ \/ log[k].tag = "free"
           \/ Bug = "claim_no_wait" /\ log[k].tag = "pending"
        /\ log' = [log EXCEPT ![k] = [FreeLog EXCEPT !.tag = "pending", !.owner = p]]
        /\ pc' = [pc EXCEPT ![p] = IF Req[p[1]].op = "edit" THEN "lock" ELSE "body"]
  /\ UNCHANGED <<rowRev, rowLock, history, inserts, reply>>

Existing(p) ==
  LET e == log[KeyOf(p)] IN
  /\ pc[p] = "existing"
  /\ reply' = [reply EXCEPT ![p] =
       IF e.payload # Req[p[1]].payload /\ Bug # "accept_mismatch"
       THEN [kind |-> "mismatch", result |-> 0]
       ELSE [kind |-> "replayed", result |-> e.result]]
  /\ pc' = [pc EXCEPT ![p] = "done"]
  /\ UNCHANGED <<log, rowRev, rowLock, history, inserts>>

Lock(p) ==
  /\ pc[p] = "lock"
  /\ rowLock = NoProc
  /\ IF rowRev # Req[p[1]].expected /\ Bug # "no_revision_check"
     THEN \* Conflict{revision_changed}: the transaction rolls back
          /\ log' = IF log[KeyOf(p)].owner = p /\ Bug # "keep_claim_on_rollback"
                    THEN [log EXCEPT ![KeyOf(p)] = FreeLog] ELSE log
          /\ rowLock' = NoProc
          /\ reply' = [reply EXCEPT ![p] = [kind |-> "stale", result |-> rowRev]]
          /\ pc' = [pc EXCEPT ![p] = "done"]
     ELSE /\ rowLock' = p
          /\ pc' = [pc EXCEPT ![p] = "body"]
          /\ UNCHANGED <<log, reply>>
  /\ UNCHANGED <<rowRev, history, inserts>>

Commit(p) ==
  LET r == p[1]
      k == KeyOf(p)
      res == IF Req[r].op = "edit" THEN rowRev + 1 ELSE 100 + p[2]
  IN
  /\ pc[p] = "body"
  /\ IF Req[r].op = "edit"
     THEN /\ rowRev' = rowRev + 1
          /\ history' = Append(history, [req |-> r, base |-> Req[r].expected])
          /\ UNCHANGED inserts
     ELSE /\ inserts' = [inserts EXCEPT ![k] = @ + 1]
          /\ UNCHANGED <<rowRev, history>>
  /\ log' = [log EXCEPT ![k] = [tag |-> "entry", owner |-> NoProc,
                                payload |-> Req[r].payload, result |-> res]]
  /\ rowLock' = IF rowLock = p THEN NoProc ELSE rowLock
  /\ reply' = [reply EXCEPT ![p] = [kind |-> "ok", result |-> res]]
  /\ pc' = [pc EXCEPT ![p] = "done"]

Abort(p) ==
  /\ pc[p] \in {"lock", "body"}
  /\ Rollback(p)
  /\ reply' = [reply EXCEPT ![p] = [kind |-> "failed", result |-> 0]]
  /\ pc' = [pc EXCEPT ![p] = "done"]
  /\ UNCHANGED <<rowRev, history, inserts>>

(* Every attempt has answered its client: the run is over. *)
Done ==
  /\ \A p \in Procs : pc[p] = "done"
  /\ UNCHANGED vars

Next ==
  \/ \E p \in Procs : Claim(p)
  \/ \E p \in Procs : Existing(p)
  \/ \E p \in Procs : Lock(p)
  \/ \E p \in Procs : Commit(p)
  \/ \E p \in Procs : Abort(p)
  \/ Done

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
TypeOK ==
  /\ pc \in [Procs -> {"idle", "existing", "lock", "body", "done"}]
  /\ rowRev \in Nat
  /\ rowLock \in Procs \cup {NoProc}
  /\ \A k \in Keys : log[k].tag \in {"free", "pending", "entry"}

(* A request key's mutation takes effect at most once, however many       *)
(* attempts overlap or retry (no duplicate Contact, no double edit).       *)
AtMostOnceEffect ==
  \A k \in Keys :
    Cardinality({i \in 1..Len(history) : Req[history[i].req].key = k}) + inserts[k] <= 1

(* Every success a client sees, first time or replayed, is the result     *)
(* stored for its key.                                                     *)
ReplayReturnsStoredResult ==
  \A p \in Procs :
    reply[p].kind \in {"ok", "replayed"} =>
      /\ log[KeyOf(p)].tag = "entry"
      /\ log[KeyOf(p)].result = reply[p].result

(* A key reused with another payload never gets the first payload's       *)
(* result: it is Conflict{idempotency_mismatch}.                           *)
MismatchNeverReplayed ==
  \A p \in Procs :
    reply[p].kind \in {"ok", "replayed"} =>
      log[KeyOf(p)].payload = Req[p[1]].payload

(* No lost update: the n-th committed edit was made from revision n, and  *)
(* the row is at 1 + the number of committed edits. A stale edit is        *)
(* rejected, never applied over a newer one.                               *)
NoLostUpdate ==
  /\ rowRev = Len(history) + 1
  /\ \A i \in 1..Len(history) : history[i].base = i
=============================================================================
