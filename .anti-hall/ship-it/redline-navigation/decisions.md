# Redline navigation release P2 decisions

- 2026-07-15 — The push-to-main Marketplace workflow does not invoke `bun run verify:metadata`. The manual release gate is verified in this release; adding the gate to CI is deferred because it changes release workflow scope.
- 2026-07-15 — Previous/Next remain enabled for zero-target reviews. Navigation safely returns without mutation; an explicit disabled/empty state is deferred as separate UX work.
- 2026-07-15 — The banner's semantic change count can differ from the navigable DOM-target count used by `Change N of M`. Navigation remains internally consistent; unifying the count definitions is deferred.
- 2026-07-15 — Switching layout resets the navigation index but retains the prior active marker/status until the next navigation click. Clearing or preserving the marker coherently is deferred as separate UX work.
