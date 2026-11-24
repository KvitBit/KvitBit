---------------------------- MODULE Empty ----------------------------
(* Negative fixture: Init is unsatisfiable, so TLC "passes" on zero states. *)
VARIABLE x
Init == x \in {}
Next == x' = x
Inv == x = x
=========================================================================
