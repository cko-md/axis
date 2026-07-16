# ADR 0004 — VECTOR runtime and engine isolation

- Status: accepted
- Date: 2026-07-16
- Wave: 15.0

## Context

VECTOR needs nine games spanning time-memory, 2D action/physics, simulation, and
3D flight/FPS. Current total static JS has limited headroom, `/command` is near
its route budget, and the lobby must not eagerly load game engines. Multiple
independent engine wrappers would duplicate lifecycle, input, save, motion,
audio, and disposal logic.

## Options considered

1. Phaser for every 2D game plus Three.js for every 3D game — mature features,
   but larger global output and two complex lifecycle surfaces.
2. Custom engine per game — maximum local control, but duplicated timing,
   input, persistence, and cleanup with high drift risk.
3. One shared Phaser runtime for 2D action/physics plus one isolated Three.js
   runtime, while keeping Second Sense engine-free — smallest surface that also
   honors Brickrise's binding Phaser requirement.

## Decision

Use option 3. Registry metadata and dynamic loader functions stay in separate
modules. `GameRuntimeHost` owns lifecycle and settings. Second Sense uses native
DOM/Canvas without a heavy engine. Phaser serves Brickrise, Time to Fly, Envoy
Arena, and Phantasy Axis. Three.js serves Paper Glider, Biome Lab, MiniTown, and
Neon Rift. Each game is a separate client chunk; `/vector` imports neither
engine.

## Rationale

Two shared engines match actual rendering needs and the required Brickrise
brief while keeping one lifecycle contract. This limits dependency weight,
cleanup paths, hidden-tab behavior, and test combinations without forcing 3D
games into a 2D abstraction.

## Consequences

- Shared runtime code needs strong fixed-step, input, visibility, audio, WebGL,
  and idempotent disposal tests before game work.
- Phaser code remains absent from lobby and Second Sense chunks. Each Phaser
  game still owns its scenes and disposes them through the shared host contract.
- Bundle budgets are measured after each game; route splitting alone does not
  justify global budget increases.

## Reversal cost

Medium. A game can adopt Phaser behind the same runtime/loader contract, but its
wave must add engine-specific disposal, performance, and offline coverage.
