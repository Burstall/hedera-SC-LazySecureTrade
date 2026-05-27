# LazySecureTrade — Blog

Long-form writing about the LST/BCF/EA marketplace stack on Hedera.
Two tracks:

- **`user/`** — Plain-language posts for traders, collectors, and
  curious humans. No deep Solidity, no Hedera arcana — just what
  the system does and why you'd care.
- **`technical/`** — Deep dives for builders. Solidity excerpts,
  Hedera-specific patterns, design-decision postmortems. Assumes
  reader is comfortable with smart contracts and JS/TS.

## Index

### User track

| # | Post | Read time |
|---|---|---|
| 01 | [What is LazySecureTrade?](user/01-what-is-lazysecuretrade.md) | ~5 min |
| 02 | [Your stash, explained](user/02-your-stash-explained.md) | ~7 min |
| 03 | [Agent envelopes — your AI trader, your rules](user/03-agent-envelopes-plain-english.md) | ~8 min |
| 04 | [Hedera vs Ethereum for NFT traders](user/04-hedera-vs-ethereum-for-nft-traders.md) | ~7 min |
| 05 | [Trading without trusting — how royalties work on LST](user/05-trading-without-trusting-royalties.md) | ~6 min |
| 06 | [What to expect at mainnet launch](user/06-what-to-expect-mainnet-launch.md) | ~6 min |
| 07 | [When is a subscription worth it? Tier-by-tier breakdown](user/07-when-is-a-subscription-worth-it.md) | ~7 min |
| 08 | [First-time agent setup — a walkthrough](user/08-first-time-agent-setup.md) | ~8 min |
| 09 | [What is $LAZY, and why are LAZY trades fee-free?](user/09-what-is-lazy-token.md) | ~6 min |
| 10 | [Reading your trade in HashScan — what each line means](user/10-reading-your-trade-in-hashscan.md) | ~7 min |

### Technical track

| # | Post | Read time |
|---|---|---|
| 01 | [Building a SNIPER agent in ~80 lines](technical/01-building-a-sniper-agent.md) | ~10 min |
| 02 | [Hedera's msg.sender auth — why we deleted ecrecover](technical/02-msg-sender-auth-model.md) | ~10 min |
| 03 | [CREATE2 stash addresses — predict before deploy](technical/03-create2-stash-prediction.md) | ~12 min |
| 04 | [Hedera's 50-subcall ceiling — how it shapes batch operations](technical/04-50-subcall-ceiling.md) | ~9 min |
| 05 | [Auction settlement and the manual royalty pull](technical/05-auction-settlement-manual-royalty.md) | ~9 min |
| 06 | [BCF storage strategy — hard-delete, swap-pop, events as memory](technical/06-bcf-storage-strategy.md) | ~9 min |
| 07 | [Stash allowance plumbing — HIP-906 + per-serial NFT approvals](technical/07-stash-allowance-plumbing.md) | ~11 min |
| 08 | [Auction anti-snipe math — why the last 10 minutes are different](technical/08-anti-snipe-math.md) | ~7 min |
| 09 | [VIPSubscription tier economics — discounts, cooldowns, and the loaner problem](technical/09-vip-subscription-economics.md) | ~9 min |
| 10 | [The 48h timelock pattern — protecting users from compromised owner keys](technical/10-48h-timelock-pattern.md) | ~11 min |
| 11 | [Beneficial-owner resolution — what stash addresses really represent](technical/11-beneficial-owner-resolution.md) | ~9 min |
| 12 | [Hardhat against live testnet — our testing methodology](technical/12-hardhat-against-live-testnet.md) | ~10 min |
| 13 | [Pull-payment queues — why we don't push refunds](technical/13-pull-payment-queues.md) | ~7 min |
| 14 | [Self-arb / wash-trade guards — why three checks instead of one](technical/14-self-arb-guards.md) | ~8 min |

## Style guide

Posts in this folder follow a few conventions so the voice stays
consistent across authors.

**Voice.** Direct and confident. Don't hedge with "I think" or
"perhaps." If a design call is contested, say so explicitly with the
trade-off named. Trust the reader to follow the argument.

**Length.** User posts target ~150-300 lines. Technical posts target
~200-400. If a draft is longer, split it.

**Frontmatter.** Each post opens with title, audience, read time,
and last-updated date. No JSON/YAML metadata — keep it human.

**Code excerpts.** Technical posts inline code freely. Keep
excerpts <30 lines; link to source rather than dumping a whole file.

**No marketing fluff.** This is not the homepage. Posts can be
opinionated about why we made a design choice, even ugly ones
(e.g., "we tried X first, blew the bytecode budget, fell back to Y").

**Update cadence.** When a post's claims are invalidated by code
change, update or supersede the post — don't leave stale advice
live. Mark superseded posts at the top with a banner pointing at
the replacement.
