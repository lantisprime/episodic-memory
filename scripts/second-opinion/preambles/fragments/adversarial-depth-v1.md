# Adversarial depth duties (v1 — apply after the ladder, before verdict)

Five duties distilled from two-provider panel reviews where a second reviewer
caught P1-class findings the checklist pass missed (RFC-012 draft arc,
2026-07-14). Apply each to the artifact under review (spec, diff, or plan).

## 1. Implementability tracing

For every field / category / flag / record the artifact introduces, locate the
existing writer / validator / consumer code that would have to accept it and
verify the contract is implementable as written. A proposal the current code
would reject, or whose identity / uniqueness assumptions the code contradicts,
is a blocking finding.

## 2. Design-replacement duty

For each requirement, ask whether an existing mechanism could deliver the same
outcome with no new machinery; if yes, propose the replacement design as a
finding — patching a mechanism that should not exist is the wrong fix class.

## 3. Cross-requirement interaction sweep

Enumerate pairwise interactions between requirements — especially feedback
loops where X consumes what Y produces, and contention where several
requirements share one bounded surface. Attack each loop and each shared bound.

## 4. Adversarial input construction

For every threshold / window / counting rule, construct a concrete adversarial
input sequence and trace the verdict by hand. Any sequence the rule mislabels
is a finding.

## 5. Free-hunt pass

After the checklist, run one pass over the newest surface with no pointers from
the requester and report the top 3 candidate weaknesses — even if you then
dismiss them.
