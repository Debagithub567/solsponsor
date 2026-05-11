# SolSponsor

**Programmable sponsorship settlement on the Solana blockchain.**

SolSponsor automates milestone and performance-based sponsorship payments using smart contracts and on-chain escrow infrastructure — eliminating paperwork, delayed approvals, invoices, intermediaries, and trust-based coordination from traditional sponsorship workflows.

---

## How It Works

Sponsorship funds are locked into secure, program-controlled escrow vaults (PDAs) and released automatically when predefined performance conditions are met. No manual approval. No intermediaries. No delays.

The current prototype demonstrates this with a **Formula 1 sponsorship scenario**: funds are deposited into PDA-controlled escrow accounts and settlement logic is executed through Solana smart contracts. Simulated oracle-based performance verification flows run alongside real on-chain transactions to demonstrate how real-world events could eventually trigger autonomous financial settlement.

---

## Tech Stack

### Backend
- **Rust** + **Anchor Framework** — smart contract development on Solana
- **PDA Vault Architecture** — secure, program-controlled escrow without centralized custody
- Smart contracts handle sponsorship initialization, escrow funding, condition verification, and payout release through state-based program execution

### Frontend
- **Next.js** + **React** + **TypeScript** + **Tailwind CSS**
- **Framer Motion** — interactive UI and transaction flow visualization
- **Phantom Wallet** — real wallet signing and live Solana devnet transactions
- **Solana Web3.js** + **Anchor client libraries** — frontend-to-on-chain-program connectivity

---

## Features

- 🔒 **On-chain escrow** — funds locked in PDA vaults, never held by a central party
- ⚡ **Automated settlement** — payments release when performance conditions are verified
- 🌐 **Oracle-ready architecture** — designed to integrate real-world event data for condition verification
- 👻 **Phantom wallet integration** — live devnet transactions with real wallet signing
- 📊 **Transaction flow visualization** — animated UI showing escrow state and settlement progress

---

## Use Cases

While the current prototype focuses on sports sponsorships, the same architecture generalizes to any conditional payment system:

| Domain | Application |
|---|---|
| Sports | Athlete/team performance-based sponsorship payouts |
| Creator Economy | Milestone-based brand deal settlements |
| Esports | Tournament prize and contract automation |
| Freelance | Deliverable-triggered milestone payments |
| Grants | On-chain milestone-gated grant disbursement |
| Payroll | Automated conditional compensation systems |

---

## Getting Started

### Prerequisites
- Node.js v18+
- Rust + Anchor CLI
- Phantom Wallet browser extension
- Solana CLI configured for devnet

### Frontend
```bash
cd frontend
npm install
npm run dev
```

### Backend (Smart Contracts)
```bash
cd backend
anchor build
anchor deploy --provider.cluster devnet
```

---

## Architecture

```
User (Phantom Wallet)
        │
        ▼
  Next.js Frontend
  (Web3.js + Anchor Client)
        │
        ▼
  Solana Devnet
        │
        ├── Sponsorship Program (Anchor)
        │       ├── Initialize sponsorship
        │       ├── Fund escrow (PDA vault)
        │       ├── Verify performance conditions
        │       └── Release payout
        │
        └── PDA Escrow Vault
                └── Holds funds until conditions met
```

---

## Vision

SolSponsor explores how blockchain infrastructure can evolve beyond speculative applications into **practical, programmable financial coordination systems**. The goal is to prove that real-world contractual obligations — historically dependent on trust, legal enforcement, and manual coordination — can be encoded directly into on-chain settlement logic, making financial agreements faster, cheaper, and trustless.

---

## License

MIT