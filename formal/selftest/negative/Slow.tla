---------------------------- MODULE Slow ----------------------------
(* Negative fixture: millions of states, so the search outlives its short timeout. *)
EXTENDS Naturals
VARIABLE x
Init == x = 0
Next == x' \in 0..100000000
=========================================================================
