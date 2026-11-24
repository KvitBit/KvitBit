--------------------------- MODULE DocumentLifecycle ---------------------------
(***************************************************************************)
(* The Proforma -> Payment Tax Document -> Final Invoice -> Credit Note     *)
(* lifecycle of @kvitbit/core (core-ports D5-D8, D13, P2, P2a, P3, S4), at  *)
(* sync commit 77a5bb7.                                                     *)
(*                                                                          *)
(* One Proforma P, its payments (slot i), the Payment Tax Document each     *)
(* payment issues (slot i, vat_payer only), one Final Invoice slot FI.      *)
(* Amounts are abstract units per VAT bucket: a payment and its PTD carry   *)
(* 1 unit in every bucket, the Final Invoice's supply 1 unit per bucket.    *)
(* The VAT arithmetic itself is verify-vat-numbering-math's.                *)
(*                                                                          *)
(* Atomic steps. Every service method runs in one CoreStore transaction     *)
(* (store/CoreStore.ts:1-12): the memory store serializes transactions      *)
(* with one semaphore (store/memory.ts:4-8,193-200); the SQL adapter is      *)
(* assumed to row-lock with SELECT ... FOR UPDATE at READ COMMITTED in S4    *)
(* order, the Proforma first (core-ports.md:1445-1447). A method is one step *)
(* when what it decides on cannot change under it: it holds the lock that   *)
(* every writer of that row takes (Payments.remove reads the PTD unlocked,  *)
(* but every PTD writer locks the Proforma first, which remove holds,       *)
(* payments.ts:205-233,483-503), or the value it reads only moves one way   *)
(* (a Final Invoice read unlocked by loadForCredit can only become          *)
(* reversed, which only lifts a block). Correcting or cancelling the Final  *)
(* Invoice locks only the Final Invoice (corrections.ts:202-205) and is one *)
(* step. The two methods of hypothesis H2 are split at their lock           *)
(* acquisitions, so the model can also run them without those locks:        *)
(*   - Documents.issueFinalInvoice (final.ts:185-255): FiStart, FiLockPtds, *)
(*     FiCommit;                                                            *)
(*   - Documents.correct / Documents.cancel of a Payment Tax Document       *)
(*     (corrections.ts:192-341, lifecycle.ts:578-641): CpStart, CpPlan,     *)
(*     CpCommit.                                                            *)
(* Each may abort before its commit (FiAbort, CpAbort): a failed            *)
(* transaction writes nothing and releases its locks (store/memory.ts:      *)
(* 130-170 restores the frame; Postgres rolls back).                        *)
(*                                                                          *)
(* Scope: a bounded lifecycle and concurrency slice, not all of D5-D8/P2/P3. *)
(* Abstractions: one Proforma; one unit per bucket per payment, PTD and     *)
(* Final Invoice supply; PTD slot i belongs to payment slot i; one          *)
(* issueFinalInvoice and one PTD correction in flight; the regime is fixed   *)
(* per run (both are explored). Not modelled: a PTD's Document Lock (it only *)
(* disables correct/cancel), the Credit Note a tax document's cancel issues  *)
(* beyond "the remainder is credited", Final Invoice patches and edits.      *)
(*                                                                          *)
(* `Mutant` selects a broken variant for the mutant configs; the base       *)
(* configs set it to "none".                                                *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Buckets,      \* VAT buckets of the Proforma (and so of each PTD)
  MaxPayments,  \* payment slots (and PTD slots)
  Mutant        \* "none" or the name of a broken variant (see the guards)

Slots == 1..MaxPayments
Zero == [b \in Buckets |-> 0]
One == [b \in Buckets |-> 1]
Credits == [Buckets -> 0..2]
Resources == {"P", "PTD", "FI"}
Owners == {"none", "fi", "cp"}

VARIABLES
  vat,       \* the Issuing Entity is a vat_payer (P2: PTDs; D6: tax documents)
  pStatus,   \* Proforma status: "draft" | "issued" | "cancelled"
  pLocked,   \* Proforma Document Lock (D5)
  pLines,    \* version of the Proforma's lines (D3a edits)
  pay,       \* payment slot i: [st: "none"|"live"|"removed", on: "P"|"FI", ptd: 0 or i]
  ptd,       \* PTD slot j: [ex: issued?, cr: credited units per bucket]
  fi,        \* the Final Invoice (see FiNone)
  fiCount,   \* Final Invoices issued for P
  holder,    \* row locks held by an in-flight multi-step transaction
  fiPc, fiDed, fiPtds,       \* issueFinalInvoice in flight
  cpPc, cpT, cpSeenFi, cpC   \* correct/cancel of PTD cpT in flight

vars == <<vat, pStatus, pLocked, pLines, pay, ptd, fi, fiCount, holder,
          fiPc, fiDed, fiPtds, cpPc, cpT, cpSeenFi, cpC>>

\* fi.ded[j]: units per bucket the Final Invoice deducts for PTD j (its
\* uncredited remainder when the FI was issued, final.ts:57-95); fi.ptds: the
\* PTDs it read; fi.deducted: the live payments it deducts (PTD or cash line,
\* final.ts:96-118); fi.cr: supply credited; fi.rev: a full remainder Credit
\* Note reversed it (settlement "credited", credit.ts:81-107,142-155).
FiNone == [ex |-> FALSE, status |-> "issued", locked |-> FALSE, cr |-> Zero,
           rev |-> FALSE, ded |-> [j \in Slots |-> Zero], ptds |-> {},
           deducted |-> {}]

PayNone == [st |-> "none", on |-> "P", ptd |-> 0]

LiveP == {i \in Slots : pay[i].st = "live" /\ pay[i].on = "P"}
LiveFI == {i \in Slots : pay[i].st = "live" /\ pay[i].on = "FI"}
FreeSlots == {i \in Slots : pay[i].st = "none"}
Free(r) == holder[r] = "none"
PtdFull(j) == \A b \in Buckets : ptd[j].cr[b] >= 1
\* FI deducts the advances and is not reversed (payments.ts:497, corrections.ts:208-213).
FiLive == fi.ex /\ fi.status = "issued" /\ ~fi.rev
FiReversed == fi.rev \/ fi.status = "cancelled"
Leq(c, d) == \A b \in Buckets : c[b] <= d[b]
Plus(c, d) == [b \in Buckets |-> c[b] + d[b]]
Minus(c, d) == [b \in Buckets |-> c[b] - d[b]]
\* A Credit Note's per-bucket credit: non-zero (corrections.ts:256-259), within
\* the uncredited remainder (D7 cap, corrections.ts:161-183,253); credit_over_cap
\* drops the cap.
CreditOptions(credited) ==
  {c \in [Buckets -> 0..1] :
     c # Zero /\ (Mutant = "credit_over_cap" \/ Leq(c, Minus(One, credited)))}

Init ==
  /\ vat \in BOOLEAN
  /\ pStatus = "draft"
  /\ pLocked = FALSE
  /\ pLines = 0
  /\ pay = [i \in Slots |-> PayNone]
  /\ ptd = [j \in Slots |-> [ex |-> FALSE, cr |-> Zero]]
  /\ fi = FiNone
  /\ fiCount = 0
  /\ holder = [r \in Resources |-> "none"]
  /\ fiPc = "idle" /\ fiDed = [j \in Slots |-> Zero] /\ fiPtds = {}
  /\ cpPc = "idle" /\ cpT = 1 /\ cpSeenFi = FALSE /\ cpC = Zero

FiVars == <<fiPc, fiDed, fiPtds>>
CpVars == <<cpPc, cpT, cpSeenFi, cpC>>

---------------------------------------------------------------------------
(* Proforma lifecycle: lifecycle.ts, transition table transitions.ts:64-123 *)

\* Documents.issue from the draft (lifecycle.ts:142-211; table draft.issue).
IssueProforma ==
  /\ pStatus = "draft"
  /\ pStatus' = "issued"
  /\ UNCHANGED <<vat, pLocked, pLines, pay, ptd, fi, fiCount, holder, FiVars, CpVars>>

\* Documents.edit of lines (lifecycle.ts:394-412): issued, unlocked, and no
\* dependents (transitions.ts:160-162: payments > 0 or a Final Invoice).
EditProformaLines ==
  /\ Free("P")
  /\ pStatus = "issued" /\ ~pLocked
  /\ LiveP = {} /\ ~fi.ex
  /\ pLines' = 1 - pLines
  /\ UNCHANGED <<vat, pStatus, pLocked, pay, ptd, fi, fiCount, holder, FiVars, CpVars>>

\* Documents.lock / unlock (lifecycle.ts:493-547).
LockProforma ==
  /\ Free("P") /\ pStatus = "issued" /\ ~pLocked
  /\ pLocked' = TRUE
  /\ UNCHANGED <<vat, pStatus, pLines, pay, ptd, fi, fiCount, holder, FiVars, CpVars>>

UnlockProforma ==
  /\ Free("P") /\ pStatus = "issued" /\ pLocked
  /\ pLocked' = FALSE
  /\ UNCHANGED <<vat, pStatus, pLines, pay, ptd, fi, fiCount, holder, FiVars, CpVars>>

\* Documents.cancel of the Proforma, a non-tax document (lifecycle.ts:597-603,
\* 644-670): unlocked, no recorded payments (paymentsBlockCancel), no Final
\* Invoice; it becomes cancelled and locked. cancel_with_payments drops the
\* payments check.
CancelProforma ==
  /\ Free("P")
  /\ pStatus = "issued" /\ ~pLocked
  /\ (Mutant = "cancel_with_payments" \/ LiveP = {})
  /\ ~fi.ex
  /\ pStatus' = "cancelled" /\ pLocked' = TRUE
  /\ UNCHANGED <<vat, pLines, pay, ptd, fi, fiCount, holder, FiVars, CpVars>>

---------------------------------------------------------------------------
(* Payments (modules/payments/service.ts, documents/payments.ts)            *)

\* Payments.record naming the Proforma before its Final Invoice
\* (service.ts:223-266): locks P (and its FI) first (payments.ts:205-234),
\* settles on P, and for a vat_payer issues PTD i in the same transaction
\* (payments.ts:364-481). A lock does not matter (P4).
RecordOnProforma(i) ==
  /\ Free("P") /\ Free("FI")
  /\ pay[i].st = "none"
  /\ pStatus = "issued" /\ ~fi.ex
  /\ pay' = [pay EXCEPT ![i] = [st |-> "live", on |-> "P", ptd |-> IF vat THEN i ELSE 0]]
  /\ ptd' = IF vat THEN [ptd EXCEPT ![i] = [ex |-> TRUE, cr |-> Zero]] ELSE ptd
  /\ UNCHANGED <<vat, pStatus, pLocked, pLines, fi, fiCount, holder, FiVars, CpVars>>

\* Payments.record on the Proforma (or the Final Invoice) once P has a Final
\* Invoice: it settles on the Final Invoice (payments.ts:227-228, D8), which must
\* be issued and not credited (service.ts:232-238); no PTD.
RecordOnFinal(i) ==
  /\ Free("P") /\ Free("FI")
  /\ pay[i].st = "none"
  /\ fi.ex /\ fi.status = "issued" /\ ~fi.rev
  /\ pay' = [pay EXCEPT ![i] = [st |-> "live", on |-> "FI", ptd |-> 0]]
  /\ UNCHANGED <<vat, pStatus, pLocked, pLines, ptd, fi, fiCount, holder, FiVars, CpVars>>

\* Payments.remove (service.ts:372-417): locks P (and FI), then P3
\* (payments.ts:483-506): a payment booked on P is blocked while a Final
\* Invoice is issued and not credited, and while its PTD is not fully credited.
\* remove_with_deduction drops the Final Invoice check.
RemovePayment(i) ==
  /\ Free("P") /\ Free("FI")
  /\ pay[i].st = "live"
  /\ pay[i].on = "P" =>
       /\ (Mutant = "remove_with_deduction" \/ ~FiLive)
       /\ (pay[i].ptd # 0 => PtdFull(pay[i].ptd))
  /\ pay' = [pay EXCEPT ![i].st = "removed"]
  /\ UNCHANGED <<vat, pStatus, pLocked, pLines, ptd, fi, fiCount, holder, FiVars, CpVars>>

---------------------------------------------------------------------------
(* Documents.issueFinalInvoice (final.ts:185-255), three steps              *)

\* Locks P (final.ts:209) and plans (final.ts:126-143): issued Proforma, no
\* Final Invoice yet (Conflict{duplicate}), at least one payment. duplicate_final
\* drops the hasFinalInvoice check (final.ts:130).
FiStart ==
  /\ fiPc = "idle" /\ Free("P")
  /\ pStatus = "issued"
  /\ (Mutant = "duplicate_final" \/ ~fi.ex)
  /\ LiveP # {}
  /\ holder' = [holder EXCEPT !["P"] = "fi"]
  /\ fiPc' = "lockedP"
  /\ UNCHANGED <<vat, pStatus, pLocked, pLines, pay, ptd, fi, fiCount, fiDed, fiPtds, CpVars>>

\* deductionLines (final.ts:57-95): row-locks each PTD (final.ts:65-66), reads
\* its Credit Notes and deducts its uncredited remainder.
FiLockPtds ==
  /\ fiPc = "lockedP" /\ Free("PTD")
  /\ holder' = [holder EXCEPT !["PTD"] = "fi"]
  /\ fiDed' = [j \in Slots |-> IF ptd[j].ex THEN Minus(One, ptd[j].cr) ELSE Zero]
  /\ fiPtds' = {j \in Slots : ptd[j].ex}
  /\ fiPc' = "lockedPtds"
  /\ UNCHANGED <<vat, pStatus, pLocked, pLines, pay, ptd, fi, fiCount, CpVars>>

\* compose, number, insert the Final Invoice, link P (final_invoice_for), commit
\* (final.ts:211-252). The deducted payments are P's live payments, read under
\* P's lock (cash line final.ts:96-118 covers what the PTDs do not).
FiCommit ==
  /\ fiPc = "lockedPtds"
  /\ fi' = [ex |-> TRUE, status |-> "issued", locked |-> FALSE, cr |-> Zero,
            rev |-> FALSE, ded |-> fiDed, ptds |-> fiPtds, deducted |-> LiveP]
  /\ fiCount' = fiCount + 1
  /\ holder' = [r \in Resources |-> IF holder[r] = "fi" THEN "none" ELSE holder[r]]
  /\ fiPc' = "idle" /\ fiDed' = [j \in Slots |-> Zero] /\ fiPtds' = {}
  /\ UNCHANGED <<vat, pStatus, pLocked, pLines, pay, ptd, CpVars>>

\* A failure before commit (compose, FX, numbering exhaustion: final.ts:212-213)
\* rolls the transaction back: nothing written, locks released.
FiAbort ==
  /\ fiPc # "idle"
  /\ holder' = [r \in Resources |-> IF holder[r] = "fi" THEN "none" ELSE holder[r]]
  /\ fiPc' = "idle" /\ fiDed' = [j \in Slots |-> Zero] /\ fiPtds' = {}
  /\ UNCHANGED <<vat, pStatus, pLocked, pLines, pay, ptd, fi, fiCount, CpVars>>

---------------------------------------------------------------------------
(* Documents.correct / cancel of PTD j (corrections.ts:192-341,             *)
(* lifecycle.ts:578-641), three steps                                       *)

\* loadForCredit (corrections.ts:192-205): the PTD's Proforma first,
\* row-locked (line 204); the Final Invoice link is read from that row. With
\* no_proforma_lock the Proforma is read without a lock: the link is a snapshot.
CpStart(j) ==
  /\ cpPc = "idle" /\ ptd[j].ex
  /\ IF Mutant = "no_proforma_lock"
       THEN UNCHANGED holder
       ELSE Free("P") /\ holder' = [holder EXCEPT !["P"] = "cp"]
  /\ cpT' = j /\ cpSeenFi' = fi.ex /\ cpPc' = "started"
  /\ UNCHANGED <<vat, pStatus, pLocked, pLines, pay, ptd, fi, fiCount, FiVars, cpC>>

\* Row-locks the PTD (corrections.ts:205), reads the Final Invoice the link
\* names (lines 206-207, unlocked) and plans (lines 223-279): not fully
\* credited, and no live Final Invoice deducting it (deductedBy, lines 208-214,
\* 235; lifecycle.ts:599); else the request fails and rolls back. The credit is
\* partial (lines 247-278) or the remainder (cancel, `lines: "full"`).
CpPlan ==
  /\ cpPc = "started" /\ Free("PTD")
  /\ LET deductedBy == cpSeenFi /\ FiLive /\ fi.ded[cpT] # Zero
     IN IF ~PtdFull(cpT) /\ ~deductedBy /\ CreditOptions(ptd[cpT].cr) # {}
          THEN /\ cpC' \in CreditOptions(ptd[cpT].cr)
               /\ holder' = [holder EXCEPT !["PTD"] = "cp"]
               /\ cpPc' = "planned"
               /\ UNCHANGED cpSeenFi
          ELSE \* Conflict{illegal_transition}: rolled back
               /\ holder' = [r \in Resources |-> IF holder[r] = "cp" THEN "none" ELSE holder[r]]
               /\ cpPc' = "idle" /\ cpSeenFi' = FALSE /\ cpC' = Zero
  /\ UNCHANGED <<vat, pStatus, pLocked, pLines, pay, ptd, fi, fiCount, FiVars, cpT>>

\* issueCreditNote (credit.ts:380-440): insert the Credit Note, link it to the
\* PTD (corrected_by), commit.
CpCommit ==
  /\ cpPc = "planned"
  /\ ptd' = [ptd EXCEPT ![cpT].cr = Plus(@, cpC)]
  /\ holder' = [r \in Resources |-> IF holder[r] = "cp" THEN "none" ELSE holder[r]]
  /\ cpPc' = "idle" /\ cpSeenFi' = FALSE /\ cpC' = Zero
  /\ UNCHANGED <<vat, pStatus, pLocked, pLines, pay, fi, fiCount, FiVars, cpT>>

\* Numbering exhaustion or a store failure before commit rolls back.
CpAbort ==
  /\ cpPc # "idle"
  /\ holder' = [r \in Resources |-> IF holder[r] = "cp" THEN "none" ELSE holder[r]]
  /\ cpPc' = "idle" /\ cpSeenFi' = FALSE /\ cpC' = Zero
  /\ UNCHANGED <<vat, pStatus, pLocked, pLines, pay, ptd, fi, fiCount, FiVars, cpT>>

---------------------------------------------------------------------------
(* The Final Invoice's own lifecycle: corrections.ts, lifecycle.ts. For an  *)
(* Invoice loadForCredit locks only the Invoice (corrections.ts:202-205).    *)

LockFinal ==
  /\ Free("FI") /\ fi.ex /\ fi.status = "issued" /\ ~fi.locked
  /\ fi' = [fi EXCEPT !.locked = TRUE]
  /\ UNCHANGED <<vat, pStatus, pLocked, pLines, pay, ptd, fiCount, holder, FiVars, CpVars>>

UnlockFinal ==
  /\ Free("FI") /\ fi.ex /\ fi.status = "issued" /\ fi.locked
  /\ fi' = [fi EXCEPT !.locked = FALSE]
  /\ UNCHANGED <<vat, pStatus, pLocked, pLines, pay, ptd, fiCount, holder, FiVars, CpVars>>

\* Partial Credit Note: supply lines only, capped by the uncredited supply
\* (corrections.ts:116-117,247-255); the deductions stay open, so the Final
\* Invoice is not "credited" (credit.ts:81-107).
CorrectFinalPartial ==
  /\ Free("FI") /\ fi.ex /\ fi.status = "issued" /\ ~fi.locked /\ ~fi.rev
  /\ \E c \in CreditOptions(fi.cr) : fi' = [fi EXCEPT !.cr = Plus(@, c)]
  /\ UNCHANGED <<vat, pStatus, pLocked, pLines, pay, ptd, fiCount, holder, FiVars, CpVars>>

\* `correct(lines: "full")` (corrections.ts:244-245), or cancel of a tax Final
\* Invoice without payments of its own (lifecycle.ts:602,615-641): a remainder
\* Credit Note reverses supply and deductions; settlement "credited".
ReverseFinal(viaCancel) ==
  /\ Free("FI") /\ fi.ex /\ fi.status = "issued" /\ ~fi.locked /\ ~fi.rev
  /\ viaCancel => vat /\ LiveFI = {}
  /\ fi' = [fi EXCEPT !.rev = TRUE, !.cr = One]
  /\ UNCHANGED <<vat, pStatus, pLocked, pLines, pay, ptd, fiCount, holder, FiVars, CpVars>>

\* Cancel of a non-tax Final Invoice (non_vat_payer, lifecycle.ts:602,643-670):
\* no payments of its own and no Credit Note; it becomes cancelled and locked.
CancelNonTaxFinal ==
  /\ Free("FI") /\ fi.ex /\ fi.status = "issued" /\ ~fi.locked /\ ~fi.rev
  /\ ~vat /\ LiveFI = {} /\ fi.cr = Zero
  /\ fi' = [fi EXCEPT !.status = "cancelled", !.locked = TRUE]
  /\ UNCHANGED <<vat, pStatus, pLocked, pLines, pay, ptd, fiCount, holder, FiVars, CpVars>>

\* No request in flight and nothing else to do: the history may stop here.
Done ==
  /\ fiPc = "idle" /\ cpPc = "idle"
  /\ UNCHANGED vars

Next ==
  \/ IssueProforma \/ EditProformaLines \/ LockProforma \/ UnlockProforma
  \/ CancelProforma
  \/ \E i \in Slots : RecordOnProforma(i) \/ RecordOnFinal(i) \/ RemovePayment(i)
  \/ FiStart \/ FiLockPtds \/ FiCommit \/ FiAbort
  \/ \E j \in Slots : CpStart(j)
  \/ CpPlan \/ CpCommit \/ CpAbort
  \/ LockFinal \/ UnlockFinal \/ CorrectFinalPartial
  \/ ReverseFinal(FALSE) \/ ReverseFinal(TRUE) \/ CancelNonTaxFinal
  \/ Done

Spec == Init /\ [][Next]_vars

---------------------------------------------------------------------------
(* Properties                                                               *)

TypeOK ==
  /\ vat \in BOOLEAN
  /\ pStatus \in {"draft", "issued", "cancelled"}
  /\ pLocked \in BOOLEAN /\ pLines \in {0, 1}
  /\ pay \in [Slots -> [st : {"none", "live", "removed"}, on : {"P", "FI"}, ptd : 0..MaxPayments]]
  /\ ptd \in [Slots -> [ex : BOOLEAN, cr : Credits]]
  /\ fi.ex \in BOOLEAN /\ fi.status \in {"issued", "cancelled"} /\ fi.locked \in BOOLEAN
  /\ fi.cr \in Credits /\ fi.rev \in BOOLEAN
  /\ fi.ptds \subseteq Slots /\ fi.deducted \subseteq Slots
  /\ fiCount \in 0..2
  /\ holder \in [Resources -> Owners]
  /\ fiPc \in {"idle", "lockedP", "lockedPtds"}
  /\ cpPc \in {"idle", "started", "planned"} /\ cpT \in Slots

\* D8: one Final Invoice per Proforma. fiCount counts issues; the model keeps
\* one Final Invoice record, so a second issue overwrites it.
OneFinalInvoice == fiCount <= 1

\* D8: a Final Invoice deducts at least one payment of a paid Proforma.
FinalInvoiceOfPaidProforma == fi.ex => fi.deducted # {}

\* P2: a vat_payer's payment on the Proforma issues exactly its own PTD;
\* payments on the Final Invoice and a non_vat_payer's payments issue none.
\* In the model this checks the slot mapping; the replay checks the real
\* payment -> PTD links (Lab.check).
PtdPerPayment ==
  /\ \A i \in Slots : pay[i].st # "none" =>
       pay[i].ptd = IF vat /\ pay[i].on = "P" THEN i ELSE 0
  /\ \A j \in Slots : ptd[j].ex <=> (pay[j].st # "none" /\ pay[j].ptd = j)

\* D8: after the Final Invoice, receipts belong to it: no PTD the Final Invoice
\* did not read.
NoPtdAfterFinal == fi.ex => {j \in Slots : ptd[j].ex} \subseteq fi.ptds

\* D6: a cancelled Proforma has no recorded payments and no Final Invoice.
CancelledProformaUnpaid == pStatus = "cancelled" => LiveP = {} /\ ~fi.ex

\* D6: a cancelled Final Invoice has no payments of its own.
CancelledFinalUnpaid == fi.ex /\ fi.status = "cancelled" => LiveFI = {}

\* D5: a cancelled document is always locked.
CancelledIsLocked ==
  /\ pStatus = "cancelled" => pLocked
  /\ fi.ex /\ fi.status = "cancelled" => fi.locked

\* P3: a removed payment on the Proforma has its PTD fully credited, and the
\* Final Invoice that deducted it is reversed.
RemovedPaymentReversed ==
  \A i \in Slots : pay[i].st = "removed" /\ pay[i].on = "P" =>
    /\ (pay[i].ptd # 0 => PtdFull(pay[i].ptd))
    /\ (fi.ex /\ i \in fi.deducted => FiReversed)

\* D7: cumulative Credit Notes never exceed the original, per bucket.
CreditWithinOriginal ==
  /\ \A j \in Slots : Leq(ptd[j].cr, One)
  /\ Leq(fi.cr, One)

\* H2 (D8, §37a): while a Final Invoice deducts a PTD, the PTD's uncredited
\* amount is exactly what the Final Invoice deducts: no PTD Credit Note lands
\* during or after the Final Invoice's issue while it stands.
DeductionsCurrent ==
  FiLive => \A j \in fi.ptds : fi.ded[j] = Minus(One, ptd[j].cr)

\* The part of the transition table (transitions.ts:64-123) this model
\* represents (narrower than the whole table: no PTD lock, no draft edits):
\* statuses move draft -> issued -> cancelled only, a Final Invoice never
\* disappears, credits and reversals are sticky, payments go none -> live ->
\* removed, and the lock of a cancelled document stays.
LegalTransitions ==
  [][ /\ (pStatus' # pStatus => <<pStatus, pStatus'>> \in
            {<<"draft", "issued">>, <<"issued", "cancelled">>})
      /\ (pStatus = "cancelled" => pLocked')
      /\ (fi.ex => fi'.ex)
      /\ (fi.ex /\ fi'.status # fi.status => fi.status = "issued" /\ fi'.status = "cancelled")
      /\ (fi.ex /\ fi.status = "cancelled" => fi'.locked)
      /\ (fi.ex /\ fi.rev /\ fiCount' = fiCount => fi'.rev)
      /\ \A j \in Slots : Leq(ptd[j].cr, ptd'[j].cr) /\ (ptd[j].ex => ptd'[j].ex)
      /\ \A i \in Slots : pay'[i].st # pay[i].st =>
            <<pay[i].st, pay'[i].st>> \in {<<"none", "live">>, <<"live", "removed">>}
   ]_vars

\* D3a: the Proforma's lines are frozen once payments or a Final Invoice depend on them.
FrozenWhenDepended ==
  [][pLines' # pLines => LiveP = {} /\ ~fi.ex]_vars
================================================================================
