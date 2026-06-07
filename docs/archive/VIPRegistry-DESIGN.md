# VIPRegistry — Superseded

**Status:** Superseded by the two-contract split.

This contract was originally proposed as a single unified `VIPRegistry` covering both holdings-based tier resolution AND paid subscriptions. During review (May 2026), it was split into two focused designs:

| New design | Purpose |
|---|---|
| **`LSHTierLib-DESIGN.md`** | Statically-linked library for LSH holdings + delegation tier resolution. Consumed by LST v2, BCF, EnglishAuction, LazyLotto. Drives trade-fee discounts. |
| **`VIPSubscription-DESIGN.md`** | Paid subscription contract. Drives agent-framework limits and other premium features. Holdings give a one-time purchase discount; trades are unaffected. |

The split resolved three concerns:

1. **Loaner-attack exposure** on the unified discount-on-purchase model. Trade fees now stay tied to active holdings via the library (re-checked per trade, can't be loaned); subscriptions have a 14-day per-serial cooldown for purchase-discount abuse mitigation.
2. **Subcall budget** — the library inlines into consumers (no cross-contract subcall for tier resolution), and short-circuits on the first positive match (1 subcall for Gen 1 holders, up to 6 for non-holders).
3. **Bytecode + architectural fit** — library handles the prestige-fixed LSH set (Gen 1 / Mutant / Gen 2); contract handles the admin-flexible discount table that can grow over time.

See `docs/AGENT-MARKETPLACE-DELTA.md` (v3+) for the broader architectural context that led to the split.

---

*This file is retained only as a redirect for any documentation that linked to the old name.*
