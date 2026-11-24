---------------------------- MODULE Broken ----------------------------
(* Negative fixture: a syntax error. TLC must stop in the parser (exit 150). *)
VARIABLE x
Init == x = 0
Next == x' = x +
=========================================================================
