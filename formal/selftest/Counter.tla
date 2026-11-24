---------------------------- MODULE Counter ----------------------------
(* Runner self-test: a bounded counter. The base config checks that x stays
   within Limit and never decreases. One mutant lowers Bound below Limit, so
   the invariant WithinBound must break; the other lets x step back, so the
   action property NoDecrease must break. *)
EXTENDS Naturals
CONSTANTS Limit, Bound, Back
VARIABLE x

Init == x = 0
Up == x < Limit /\ x' = x + 1
Down == Back /\ x > 0 /\ x' = x - 1
Done == x = Limit /\ UNCHANGED x
Spec == Init /\ [][Up \/ Down \/ Done]_x

TypeOK == x \in 0..Limit
WithinBound == x <= Bound
NoDecrease == [][x' >= x]_x
=========================================================================
