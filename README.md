# hedera-SC-LazySecureTrade
Decentralized NFT Trading without time constraint using Solidity EVM on Hedera via the LazySecureTrade (LST) contract.

This is the building block to a full decentralized marketplace #HelloFuture

version 0.1 - Single NFT per trade.

# Testing
create .env:
ENVIRONMENT=test
ACCOUNT_ID=
PRIVATE_KEY=

```yarn```
```yarn run test-trade```

# Deploy Notes

contract has an embedded sunset @ 90 days (extendable) to assist in forcing migration to future versions

# Create Trade
- User sets an allowance for the NFT (per serial of all serials) to the LST
- User creates a Trade:
	- Specifies price in HBAR (tinybar), $LAZY (if applicable), token, serial, expirytime (0 = never)
	- If association is required by contract pass the boolean (check vis isTokenAssociated() ) and add 950_000 gas [1 time per token]
	- If specific buyer specified, service is *FREE* to use
	- If <any> buyer specified (address(0)) then there is a cost of [x] $LAZY **ensure allowance to Lazy Gas Station (LGS)** *unless user owns/has delegated LSH Gen 1 / 2 tokens*
	- creating a trade will iterate a users existing trades and prune them [could be gas heavy if there is massive usage]

# Query Trade(s)
Use the free read-only calls via Mirror Nodes
- getUserTrades(address _user) -> bytes32[] of trades [user could be buyer or seller]
- getTokenTrades(address _token) -> bytes32[] of trades [no buyer specified]
- getTrade(bytes32) / getTrades(bytes32[]) to get the Trade objects
- isTradeValid(bytes32 _tradeId, address _user) validate a trade for a user or <any> user
- getTokens(uint256 offset, uint256 batch) (use getTotalTokens() to get full size)

# Cancel Trade
- cancelTrade(bytes32 _tradeId) only possible when user is noted as seller on the trade
( cancelling the allowance or moving the NFT will implicitly cancel the trade but it could be come live again if
not purged on fresh trade creation and allowance/movement is restablished)

# Execute Trade
Buyer must have a 1 tinybar allowance to LST contract to facilitate the transfer of NFT.
- executeTrade(bytes32)
	- payable function, send hbar as value for the tinybar price
	- Checks trade is valid for msg.sender
	- Ensures msg.sender is not seller per the Trade object
	- Checks value is sufficient, refunds the difference
	- If a $LAZY payment element [buyer must have sufficient $LAZY allowance to LGS] take $LAZY and pay to seller
	- Transfer NFT from seller to Smart Contract for hbar value [defaults to 1 tinybar if none set] -- contract pays
	- Transfer NFT from Smart Contract to Buyer for 1 tinybar

# Scripts
Plenty of scripts to allow easy usage from the command line. Highlights below.
 scripts/deployments
  -> deployLazySecureTrade.js : interactive. allows component reuse via .env file
  -> extractABI.js : helper to get the ABI post compile
 scripts/interactions
  -> cancelTrade.js
  -> createTrade.js
  -> executeTrade.js
  -> getLazySecureTradeLogs.js [writes the emitted events to log file]
  -> getTokenTrades.js [a list of hashes for trades]
  -> getTrade.js [get the trade details from a hash]
  -> getTradesForUser.js
  -> isTradeValid.js [checks validity of trade based on specified buyer, allowances and expiry if set]
