# ADR 0006 — Time to Fly: disjoint gravity fields, because a provably-solvable level is not the same as a solvable level

- Status: accepted
- Date: 2026-07-19
- Wave: 15.9 (Time to Fly), VECTOR arcade

## Context

`docs/vector/PLAN.md` binds Time to Fly to a demanding set of constraints that
interact badly:

- five levels; **level N contains N planets**;
- planets move only by pre-launch drag along **fixed circular orbits**;
- **no trajectory preview**;
- **every planet materially contributes to each valid solution**;
- **only a small number of valid solutions per level**;
- levels are **generated from a seed**, and a new game mints a new seed.

The hard part is that the last three must hold *for every seed*. Necessity and
near-uniqueness cannot be play-tested into existence one level at a time; the
generator has to guarantee them, and a test has to prove them in bounded time.

Three designs were developed independently and scored by three judges (spec
compliance, determinism/feasibility, playability):

| Design | Approach | Spec | Determinism | Playability |
| --- | --- | --- | --- | --- |
| constructive | Build the level around an intended winning flight, then count solutions exhaustively | 9 | 9 | fatal |
| rejection | Sample a level, verify, deterministically resample until it passes | 5 | 8 | best |
| discrete | Shrink the solution space until the properties are cheap to prove | 7 | 5 | middle |

`constructive` won two of the three judges outright. It had the strongest
correctness story — solvable by construction, necessity and solution count
established by complete lattice enumeration, cross-checked against naive brute
force at N=2..4 with zero mismatches — and the only unconditional cross-machine
determinism argument (no transcendentals anywhere on the generation or
simulation path).

## Decision

**Adopt `constructive` as the base, but make gravity fields disjoint, adopting
the sequential-sector structure from `rejection`.**

Also grafted, each because a specific judge demonstrated the need:

- Ray-casting is a **prune predicate only** and never advances state.
  `constructive`'s prototype advanced free flight analytically
  (`px += vx * jump` in place of `jump` successive `px += vx`), which is not
  bit-identical in IEEE-754. A solver that fast-forwards and a shell that steps
  would eventually disagree about a flight, which would make a "solution" one
  the player cannot reproduce.
- A **decision-margin band**: reject any level where an enumerated branch's
  closest approach to the galaxy lands near the capture radius, so no solution
  is decided by a rim-graze the player cannot see.
- A **clean-arrival constraint**: at least one solution must arrive comfortably
  inside the target, so the intended answer is something a player can aim at.
- **Retry preserves the arrangement as launched**, with an explicit reset that
  restores the seeded starting positions. `rejection` restored the seeded
  positions on every miss, which at its own measured median of 136 launches on
  level 5 would make the player rebuild their work after every attempt.
- **Continuous drag rendering**: the planet follows the raw pointer angle
  during the drag and eases to the nearest slot on release, with no tick marks
  or slot indices in the UI. The state is discrete; the interaction should not
  advertise it.

## Why: the measured reason

`constructive`'s levels are provably solvable and effectively unsolvable.

The playability judge did not argue this — it wrote a chain-aware informed
player model and ran it against `constructive`'s own generator. Independently
reproduced (`scratchpad/judge_d2.mjs`), 12 seeds per level, 3000-launch budget:

| Planets | Unsolved | Median launches |
| --- | --- | --- |
| 2 | 0 / 12 | 18 |
| 3 | 3 / 12 | 867 |
| 4 | **9 / 12** | budget exhausted |
| 5 | **10 / 12** | budget exhausted |

The cause is structural, not a tuning miss. With overlapping fields the flight
is a chaotic function of all N angles at once: moving one planet by one detent
changes everything downstream, so a miss carries no information about which
planet was wrong or in which direction. There is no gradient to climb, and a
puzzle with no gradient and no trajectory preview is not solvable by reasoning
— only by exhaustive search the player is not equipped to do.

Disjoint fields fix this at the root. The flight becomes a sequence of
independent single-planet deflections, so planet *k* affects the trajectory
only from sector *k* onward. The player solves sector by sector, progress is
monotone, and every miss identifies the sector that failed. `rejection`, which
had this property, measured **zero** unsolved levels.

Disjointness pays a second time: it collapses verification from an exponential
lattice search to a layered one that is linear in N. `constructive`'s exhaustive
enumeration was its cost risk — its stated N=5 node budget headroom was 5.5x,
but re-running its own driver measured 32,569 nodes rather than the claimed
10,945, i.e. 1.8x. Layered verification removes that risk rather than managing
it.

### What is deliberately not adopted

`rejection` enforced necessity with **barriers containing apertures** — a
prominent on-screen element the binding spec never names, on a program where the
owner has already rejected two designs. Barriers were its necessity mechanism,
not its gradient mechanism; the gradient comes from field disjointness alone.
Necessity is instead proven the way `constructive` did it: exhaustive ablation
over the lattice, which the disjoint structure now makes cheap.

## Consequences

- Only one planet exerts force at any instant. "Gravity depends naturally on
  strength, distance, and entry geometry" remains true per fly-by — deflection
  still falls out of integrating a central force, and larger planets still
  exert stronger force across a larger field radius. What is given up is
  simultaneous multi-body superposition, which the spec does not require.
- Field disjointness is a hard generation constraint and consumes arena area.
  Level 5 packing feasibility must be verified by the generator, not assumed;
  `discrete` named this as its own top risk and never measured it.
- **A solvability-gradient test is mandatory and blocking**, in the same way
  Brickrise's reachability test is. Wave 15.8 shipped a tower whose floors were
  29 px beyond the jump height, with 42 passing tests, because every test
  asserted the floors were evenly spaced and none asserted one was reachable.
  The equivalent failure here is a level that is provably solvable and humanly
  unsolvable — which is exactly what the winning design turned out to produce.
  A player-model test that asserts levels are solvable within a launch budget is
  the invariant that catches it, and no amount of paper reasoning substitutes.

## Status of the prototypes

The design prototypes and the player model live in the session scratchpad and
are **not** part of the repository. Their measured figures are quoted above as
evidence for the decision; the shipped implementation carries its own tests.
