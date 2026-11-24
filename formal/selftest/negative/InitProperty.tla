---------------------------- MODULE InitProperty ----------------------------
(* Fixture: the property IsOne already fails in the initial state, which TLC
   1.7.4 reports as "Property IsOne is violated by the initial state" (exit 13). *)
EXTENDS Naturals
VARIABLE x
Init == x = 0
Next == x < 2 /\ x' = x + 1
Spec == Init /\ [][Next]_x
IsOne == x = 1
=========================================================================
