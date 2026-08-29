# Agent Note: Shadowing a single-kind slot cell — the ui-active-sessions sidebar variant

Status: implemented

English | [中文](2026-08-26-ui-active-sessions-shadow-sidebar-cell.zh.md)

> Scope: how `packages/client/ui-active-sessions` replaces the sidebar's browsing region without touching `ui-workspace`, why cell shadowing by registration `priority` is the sanctioned mechanism for whole-region variants, and which affordances that tradeoff deliberately gives up. The [slot system standard](2026-07-22-slot-type-chain-implementation.md) owns the composition model this extends.

## Problem

The sidebar's browsing region is one single-kind cell (`'sidebar.workspaces'`) rendered by whichever entry occupies it; `ui-workspace` owns it and, with it, the add/rename/archive affordances. A product variant wants the same region reorganized around session activity — running, waiting-on-user, and finished-unseen sessions hoisted into one unified section above workspace groups, every section strictly newest-first. Forking `ui-workspace` or threading an option through its component would put a second presentation mode inside a package whose contracts (manual drag order, directory flow) exist precisely because the default behavior is settled.

## Decision

**A variant that replaces a whole region registers into the same declared slot at a lower `priority`; the slot system renders the lowest live entry of a single-kind cell while the others stay mounted underneath.**

- `ui-active-sessions` registers `ActiveSessionsBrowser` with `priority: -1`. `ui-workspace` keeps its default-priority registration untouched: still mounted, still declaring `sidebar.workspaces.directoryFlow`, still owning its store. Removing the variant's composition row in `packages/bundle/web-app/cordis.patch.yml` — or disposing its entry — restores the stock browser without a reload.
- Ordering is part of the variant's contract, not an option: sections derive from list snapshots through pure functions (`src/client/view.ts`) and sort by last activity. The stock browser's persisted manual account order is intentionally not honored there; the two presentations are alternative products, not modes of one.
- Static registrations honor an explicit distinct `priority`; same key + same priority throws. (Dynamic-plugin packages differ: the dev-mode Guard overwrites caller-supplied priorities with page-local ranks, which is why the dynamic prototype of this feature had to be a self-contained replacement instead.)

### What shadowing gives up, on purpose

While the variant wins the cell, the stock browser's affordances vanish from view even though its code stays mounted: no sidebar Add-workspace shortcut (the hero picker remains), no rename/fork/archive menus, no drag reorder. These are documented as the package's Known Limitations rather than papered over — re-adding them would mean either duplicating `directoryFlow` declarations (a load-time conflict with the mounted owner) or extending this package into a second full browser. If the variant ever needs those surfaces, the right move is negotiating child slots with `ui-workspace`, not reaching into its internals from outside.

## Alternatives considered

**Fork or add a mode flag to `ui-workspace`.** Rejected because putting a second presentation mode inside `ui-workspace` entangles two divergent product concepts and violates its settled contracts.

**Negotiate child slots within the stock browser.** Deferred until finer-grained extension is required; for a whole-region reorganization, slot shadowing at a distinct priority satisfies the requirement cleanly without modifying the base package.

## Consequences

- Region-level variants are additive and cheap to ship or retract; they never require coordinated releases of the region's owner.
- The pattern is for whole-region replacement only. Anything finer-grained belongs behind a child slot declared by the owning entry, where declaration ownership stays enforceable.
- Two mounted browsers mean two copies of region-local state; only the winning entry's state is visible, so the loser must not own durable side effects. Both entries here are pure presenters over shared runtime snapshots, which keeps that rule satisfied by construction.
