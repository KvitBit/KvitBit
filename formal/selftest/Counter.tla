---------------------------- MODULE Counter ----------------------------
(* Runner self-test: a bounded counter. The base config checks that x stays
   within Limit; the mutant config lowers the bound so the invariant must break. *)
EXTENDS Naturals
CONSTANTS Limit, Bound
VARIABLE x

Init == x = 0
Next == x < Limit /\ x' = x + 1
Done == x = Limit /\ UNCHANGED x
Spec == Init /\ [][Next \/ Done]_x

TypeOK == x \in 0..Limit
WithinBound == x <= Bound
=========================================================================
