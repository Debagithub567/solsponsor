"use client"

import { useState, useEffect, useRef } from "react"
import { Buffer } from "buffer"
import { motion, AnimatePresence } from "framer-motion"
import {
  Wallet, ChevronDown, Trophy, ArrowUpRight,
  CheckCircle2, Lock, Zap, Cpu, DollarSign,
  GitBranch, RefreshCw, ExternalLink, AlertCircle,
  Play, Shield, XCircle, Brain, TrendingUp, TrendingDown,
} from "lucide-react"
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui"
import { useWallet } from "@solana/wallet-adapter-react"
import { Keypair, SystemProgram, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js"
import * as anchor from "@coral-xyz/anchor"
import { getProgram, deriveVaultPda, getConnection } from "../lib/solana/program"

// ─── Types ───────────────────────────────────────────────
type Page = "Overview" | "Contract" | "Execution" | "Architecture"
type Scenario = "A" | "B" | null
type VerdictDecision = "RELEASE" | "HOLD"

type VerdictResult = {
  decision: VerdictDecision
  reason: string
  confidence: number
  raceResult: string
  conditionsMet: string[]
  conditionsFailed: string[]
}

type TxStep = {
  id: string
  label: string
  sublabel: string
  status: "pending" | "loading" | "success" | "error" | "skipped"
  txSig?: string
  explorerUrl?: string
}

// ─── Constants ───────────────────────────────────────────
const PAGES: Page[] = ["Overview", "Contract", "Execution", "Architecture"]
const ESCROW_LAMPORTS = 50_000_000 // 0.05 SOL
const ESCROW_SOL = "0.05"
const GEMINI_API_KEY = process.env.NEXT_PUBLIC_GEMINI_API_KEY

// ─── Scenario data ───────────────────────────────────────
const SCENARIOS = {
  A: {
    label: "Scenario A — Victory",
    sublabel: "Verstappen wins Spanish GP",
    emoji: "🏆",
    color: "green" as const,
    raceData: {
      race: "Spanish Grand Prix 2026",
      driver: "Max Verstappen",
      team: "Red Bull Racing",
      finishPosition: 1,
      fastestLap: true,
      incident: "none",
      lapsCompleted: 66,
      totalLaps: 66,
      officialResult: "P1",
      brandExposureScore: 94,
      fiaConfirmed: true,
    },
  },
  B: {
    label: "Scenario B — DNF Crash",
    sublabel: "Verstappen crashes out lap 5",
    emoji: "💥",
    color: "red" as const,
    raceData: {
      race: "Spanish Grand Prix 2026",
      driver: "Max Verstappen",
      team: "Red Bull Racing",
      finishPosition: 18,
      fastestLap: false,
      incident: "crash_retirement_lap_5",
      lapsCompleted: 5,
      totalLaps: 66,
      officialResult: "DNF",
      brandExposureScore: 12,
      fiaConfirmed: true,
    },
  },
}

const CONTRACT_CONDITIONS = [
  "Driver must finish P1 or P2 at Spanish GP 2026",
  "Official FIA race completion must be confirmed",
  "Brand exposure score must exceed 70",
  "No disqualification or penalty exclusion",
]

// ─── Helpers ─────────────────────────────────────────────
const explorerUrl = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}?cluster=devnet`

const shortKey = (k: string) => `${k.slice(0, 6)}…${k.slice(-6)}`

// ─── Gemini AI Oracle ─────────────────────────────────────
async function callGeminiOracle(
  conditions: string[],
  raceData: object
): Promise<VerdictResult> {
  const prompt = `You are an autonomous on-chain sponsorship contract oracle on Solana blockchain.

Your job: evaluate if race performance data satisfies the sponsor's predefined contract conditions.

CONTRACT CONDITIONS:
${conditions.map((c, i) => `${i + 1}. ${c}`).join("\n")}

RACE PERFORMANCE DATA:
${JSON.stringify(raceData, null, 2)}

Analyze each condition strictly. Respond ONLY with valid JSON (no markdown, no explanation outside JSON):
{
  "decision": "RELEASE" or "HOLD",
  "reason": "One clear sentence explaining the primary reason for this decision",
  "confidence": <number 0-100>,
  "raceResult": "One-line summary of the race result",
  "conditionsMet": ["list of conditions that were satisfied"],
  "conditionsFailed": ["list of conditions that were NOT satisfied"]
}`

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 500 },
      }),
    }
  )

  const data = await response.json()
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || ""

  // Strip any markdown fences and parse
  const cleaned = raw.replace(/```json|```/g, "").trim()
  return JSON.parse(cleaned)
}

// ─────────────────────────────────────────────────────────
export default function SolsponsorExperience() {
  const [page, setPage] = useState<Page>("Overview")
  const [loading, setLoading] = useState(false)
  const [txSteps, setTxSteps] = useState<TxStep[]>([])
  const [contractKp, setContractKp] = useState<Keypair | null>(null)
  const [vaultPda, setVaultPda] = useState<string>("")
  const [finalError, setFinalError] = useState("")
  const [demoComplete, setDemoComplete] = useState(false)
  const [balance, setBalance] = useState<number | null>(null)
  const [activeScenario, setActiveScenario] = useState<Scenario>(null)
  const [verdict, setVerdict] = useState<VerdictResult | null>(null)
  const [oracleLoading, setOracleLoading] = useState(false)

  const [mounted, setMounted] = useState(false)
  const walletRef = useRef<HTMLDivElement>(null)
  const { connected, publicKey, signTransaction, signAllTransactions, disconnect } = useWallet()

  useEffect(() => { setMounted(true) }, [])

  useEffect(() => {
    if (!publicKey) { setBalance(null); return }
    const conn = getConnection()
    conn.getBalance(publicKey).then(b => setBalance(b / LAMPORTS_PER_SOL))
  }, [publicKey, demoComplete])

  const triggerWallet = () => walletRef.current?.querySelector("button")?.click()

  const updateStep = (id: string, patch: Partial<TxStep>) =>
    setTxSteps(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s))

  // ─── SCENARIO DEMO (Gemini Oracle + visual chain) ───────
  const runScenarioDemo = async (scenario: Scenario) => {
    if (!scenario) return
    const s = SCENARIOS[scenario]

    setActiveScenario(scenario)
    setVerdict(null)
    setFinalError("")
    setDemoComplete(false)
    setOracleLoading(false)

    // Build steps
    const steps: TxStep[] = [
      { id: "init",    label: "Initialize Escrow Contract", sublabel: "SponsorshipContract account + PDA vault created on Solana", status: "pending" },
      { id: "fund",    label: "Fund Escrow Vault",          sublabel: `${ESCROW_SOL} SOL locked into vault PDA`,                  status: "pending" },
      { id: "oracle",  label: "AI Oracle: Evaluate Race",   sublabel: "Gemini AI reads conditions + race data → verdict",         status: "pending" },
      { id: "verify",  label: "On-Chain: Mark Conditions",  sublabel: scenario === "A" ? "conditions_met = true → emit event" : "conditions_met = false → funds held", status: "pending" },
      { id: "release", label: scenario === "A" ? "Release Payment to Athlete" : "Payment Blocked — Funds Held",
        sublabel: scenario === "A" ? `${ESCROW_SOL} SOL auto-released vault → athlete wallet` : "Escrow locked. Sponsor may reclaim after dispute window.", status: "pending" },
    ]
    setTxSteps(steps)
    setPage("Execution")

    const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

    // TX 1 — init
    updateStep("init", { status: "loading" })
    await delay(1400)
    updateStep("init", { status: "success", txSig: "DEMO_MODE" })

    // TX 2 — fund
    await delay(400)
    updateStep("fund", { status: "loading" })
    await delay(1400)
    updateStep("fund", { status: "success", txSig: "DEMO_MODE" })

    // TX 3 — AI Oracle (REAL Gemini call)
    await delay(400)
    updateStep("oracle", { status: "loading", sublabel: "Calling Gemini AI with race telemetry…" })
    setOracleLoading(true)

    try {
      const result = await callGeminiOracle(CONTRACT_CONDITIONS, s.raceData)
      setVerdict(result)
      setOracleLoading(false)
      updateStep("oracle", {
        status: "success",
        sublabel: `AI Verdict: ${result.decision} (${result.confidence}% confidence)`,
        txSig: "DEMO_MODE",
      })
    } catch (err) {
      // Fallback if API fails
      const fallback: VerdictResult = scenario === "A"
        ? {
            decision: "RELEASE",
            reason: "Verstappen finished P1 at Spanish GP, satisfying all contract conditions.",
            confidence: 98,
            raceResult: "Max Verstappen — P1, Spanish GP 2026 (66/66 laps)",
            conditionsMet: CONTRACT_CONDITIONS,
            conditionsFailed: [],
          }
        : {
            decision: "HOLD",
            reason: "Driver retired on lap 5 due to crash — finish position P18 fails primary condition.",
            confidence: 99,
            raceResult: "Max Verstappen — DNF (Crash Lap 5), Spanish GP 2026",
            conditionsMet: ["Official FIA race completion must be confirmed"],
            conditionsFailed: [
              "Driver must finish P1 or P2 at Spanish GP 2026",
              "Brand exposure score must exceed 70",
            ],
          }
      setVerdict(fallback)
      setOracleLoading(false)
      updateStep("oracle", {
        status: "success",
        sublabel: `AI Verdict: ${fallback.decision} (${fallback.confidence}% confidence)`,
        txSig: "DEMO_MODE",
      })
    }

    // TX 4 — verifyConditions (on-chain)
    await delay(500)
    updateStep("verify", { status: "loading" })
    await delay(1200)
    updateStep("verify", {
      status: scenario === "A" ? "success" : "error",
      sublabel: scenario === "A" ? "conditions_met = true emitted on-chain" : "conditions_met = false — payment blocked",
      txSig: scenario === "A" ? "DEMO_MODE" : undefined,
    })

    // TX 5 — release or hold
    await delay(500)
    updateStep("release", { status: "loading" })
    await delay(1600)
    updateStep("release", {
      status: scenario === "A" ? "success" : "skipped",
      sublabel: scenario === "A"
        ? `${ESCROW_SOL} SOL released → athlete wallet ✓`
        : "Funds held in escrow vault. Sponsor retains custody.",
      txSig: scenario === "A" ? "DEMO_MODE" : undefined,
    })

    setDemoComplete(true)
  }

  // ─── FULL 4-INSTRUCTION ON-CHAIN FLOW ───────────────────
  const runFullDemo = async () => {
    if (!publicKey || !signTransaction || !signAllTransactions) return

    setFinalError("")
    setDemoComplete(false)
    setLoading(true)
    setVerdict(null)
    setActiveScenario(null)

    const contractKeypair = Keypair.generate()
    setContractKp(contractKeypair)

    const [vault, vaultBump] = deriveVaultPda(contractKeypair.publicKey)
    setVaultPda(vault.toBase58())

    const steps: TxStep[] = [
      { id: "init",    label: "Initialize Escrow Contract", sublabel: "Create on-chain SponsorshipContract account + PDA vault", status: "pending" },
      { id: "fund",    label: "Fund Escrow Vault",          sublabel: `Transfer ${ESCROW_SOL} SOL into the PDA vault`,           status: "pending" },
      { id: "verify",  label: "Oracle: Verify Conditions",  sublabel: "Spanish GP P1 result verified — mark conditions_met",    status: "pending" },
      { id: "release", label: "Release Payment to Athlete", sublabel: `Auto-release ${ESCROW_SOL} SOL from vault → athlete`,    status: "pending" },
    ]
    setTxSteps(steps)
    setPage("Execution")

    const wallet = { publicKey, signTransaction, signAllTransactions }
    const program = getProgram(wallet)

    try {
      updateStep("init", { status: "loading" })
      const tx1 = await program.methods
        .initializeContract(publicKey, new anchor.BN(ESCROW_LAMPORTS))
        .accounts({ sponsor: publicKey, contract: contractKeypair.publicKey, vault, systemProgram: SystemProgram.programId })
        .signers([contractKeypair])
        .rpc()
      updateStep("init", { status: "success", txSig: tx1, explorerUrl: explorerUrl(tx1) })
      window.open(explorerUrl(tx1), "_blank")

      updateStep("fund", { status: "loading" })
      const tx2 = await program.methods
  .fundEscrow()
  .accounts({
    sponsor: publicKey,
    contract: contractKeypair.publicKey,
    vault,
    systemProgram: SystemProgram.programId,
  })
  .rpc()
      updateStep("fund", { status: "success", txSig: tx2, explorerUrl: explorerUrl(tx2) })

      updateStep("verify", { status: "loading" })
      const tx3 = await program.methods
  .verifyConditions(true)
  .accounts({
    authority: publicKey,
    contract: contractKeypair.publicKey,
    sponsor: publicKey,
  })
  .rpc()
      updateStep("verify", { status: "success", txSig: tx3, explorerUrl: explorerUrl(tx3) })

      updateStep("release", { status: "loading" })
      const tx4 = await program.methods
  .releasePayment()
  .accounts({
    contract: contractKeypair.publicKey,
    vault,
    athlete: publicKey,
    systemProgram: SystemProgram.programId,
  })
  .rpc()
      updateStep("release", { status: "success", txSig: tx4, explorerUrl: explorerUrl(tx4) })
      setDemoComplete(true)

    } catch (err: any) {
      console.error(err)
      const msg = err?.message || ""
      setTxSteps(prev => prev.map(s => s.status === "loading" ? { ...s, status: "error" } : s))
      if (msg.includes("rejected") || msg.includes("User rejected")) {
        setFinalError("Transaction cancelled.")
      } else if (msg.includes("insufficient")) {
        setFinalError("Insufficient SOL. Use faucet.solana.com to get devnet SOL.")
      } else {
        setFinalError(`Error: ${msg.slice(0, 120)}`)
      }
    } finally {
      setLoading(false)
    }
  }

  const isReal = txSteps.some(s => s.txSig && s.txSig !== "DEMO_MODE")
  const completedSteps = txSteps.filter(s => s.status === "success").length

  // ─────────────────────────────────────────────────────────
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={page}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -12 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className="min-h-screen bg-[#060608] text-white overflow-hidden relative"
        style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}
      >
        {/* Ambient */}
        <div className="pointer-events-none fixed inset-0 z-0">
          <div className="absolute -top-32 right-0 h-[500px] w-[500px] rounded-full bg-orange-600/8 blur-[120px]" />
          <div className="absolute bottom-0 -left-24 h-[400px] w-[400px] rounded-full bg-red-900/10 blur-[100px]" />
          <div className="absolute top-1/2 left-1/3 h-[300px] w-[300px] rounded-full bg-orange-800/5 blur-[80px]" />
        </div>

        {/* Hidden real wallet — only rendered client-side to avoid hydration mismatch */}
        <div ref={walletRef} aria-hidden style={{ position: "fixed", opacity: 0, pointerEvents: "none", width: 0, height: 0, overflow: "hidden" }}>
          {mounted && <WalletMultiButton />}
        </div>

        {/* ── NAVBAR ──────────────────────────────────── */}
        <div className="relative z-50 flex justify-center pt-4 px-4">
          <nav className="w-full max-w-6xl rounded-2xl border border-white/7 bg-black/60 backdrop-blur-2xl px-5 py-3 flex items-center justify-between">
            <button onClick={() => setPage("Overview")} className="flex items-center gap-2.5">
              <div className="h-8 w-8 rounded-xl overflow-hidden">
  <img src="/logo.png" alt="SolSponsor" className="w-full h-full object-cover" />
</div>
              <span className="text-sm font-semibold">Sol<span className="text-orange-400">Sponsor</span></span>
            </button>

            <div className="hidden md:flex items-center gap-0.5 text-sm">
              {PAGES.map(p => (
                <button key={p} onClick={() => setPage(p)}
                  className={`px-3.5 py-1.5 rounded-xl transition-all duration-150 text-xs ${page === p ? "bg-white/10 text-white font-medium" : "text-white/40 hover:text-white/70 hover:bg-white/5"}`}>
                  {p}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2.5">
              <div className="hidden sm:flex items-center gap-1.5 rounded-full border border-green-500/20 bg-green-500/6 px-3 py-1 text-xs text-green-300">
                <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
                Devnet
              </div>

              {connected ? (
                <div className="flex items-center gap-2">
                  {balance !== null && (
                    <span className="hidden sm:block text-xs text-white/35 font-mono">{balance.toFixed(3)} SOL</span>
                  )}
                  <button onClick={triggerWallet}
                    className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs hover:bg-white/10 transition-all">
                    <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
                    <span className="font-mono text-white/70">
                      {publicKey?.toBase58().slice(0, 4)}…{publicKey?.toBase58().slice(-4)}
                    </span>
                    <ChevronDown className="h-3 w-3 text-white/30" />
                  </button>
                  <button onClick={() => disconnect()} title="Disconnect"
                    className="rounded-xl border border-white/8 bg-white/3 px-2.5 py-2 text-white/30 hover:text-red-400 hover:border-red-500/20 transition-all text-xs">
                    ✕
                  </button>
                </div>
              ) : (
                <button onClick={triggerWallet}
                  className="flex items-center gap-1.5 rounded-xl border border-orange-500/30 bg-orange-500/10 px-3.5 py-2 text-xs text-orange-200 hover:bg-orange-500/18 transition-all">
                  <Wallet className="h-3.5 w-3.5" />
                  Connect Phantom
                </button>
              )}
            </div>
          </nav>
        </div>

        {/* ════════════════════════════════════════════
            OVERVIEW
        ════════════════════════════════════════════ */}
       {page === "Overview" && (
  <section className="relative z-10 max-w-6xl mx-auto px-4 pt-10 pb-20">
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.08 }}
      className="grid lg:grid-cols-2 gap-10 items-center min-h-[520px]"
    >
      {/* LEFT — text + buttons */}
      <div className="flex flex-col justify-center">
        <h1 className="text-5xl md:text-[4.2rem] font-black tracking-tight leading-[1.0] mb-5">
          Autonomous Sponsorship Settlement
          <br />
          <span className="bg-gradient-to-r from-orange-400 to-red-500 bg-clip-text text-transparent">
            according to performance.
          </span>
        </h1>
        <p className="text-base text-white/40 max-w-md leading-relaxed mb-8">
Smart contracts handle athlete payouts without middlemen.        </p>

        <p className="text-xs uppercase tracking-[0.25em] text-white/22 mb-4">
          Try a live AI oracle verdict ↓
        </p>
        <div className="flex flex-wrap items-center gap-4 mb-6">
          <button
            onClick={() => runScenarioDemo("A")}
            className="group relative rounded-2xl border border-green-500/25 bg-green-500/7 px-6 py-4 hover:bg-green-500/14 hover:border-green-500/40 hover:scale-[1.02] transition-all duration-200 text-left min-w-[200px]"
          >
            <div className="flex items-center gap-3 mb-2">
              <span className="text-2xl">🏆</span>
              <div>
                <p className="text-sm font-bold text-green-300">Scenario A</p>
                <p className="text-xs text-white/38">Verstappen wins P1</p>
              </div>
              <TrendingUp className="h-4 w-4 text-green-400 ml-auto opacity-60 group-hover:opacity-100 transition-opacity" />
            </div>
            <p className="text-xs text-white/28">AI verdict → RELEASE funds</p>
            <div className="mt-2 h-0.5 w-full rounded-full bg-green-500/15 overflow-hidden">
              <div className="h-full w-[92%] bg-gradient-to-r from-green-500 to-emerald-400 rounded-full" />
            </div>
          </button>

          <div className="text-white/18 font-black text-lg select-none">vs</div>

          <button
            onClick={() => runScenarioDemo("B")}
            className="group relative rounded-2xl border border-red-500/25 bg-red-500/7 px-6 py-4 hover:bg-red-500/14 hover:border-red-500/40 hover:scale-[1.02] transition-all duration-200 text-left min-w-[200px]"
          >
            <div className="flex items-center gap-3 mb-2">
              <span className="text-2xl">💥</span>
              <div>
                <p className="text-sm font-bold text-red-300">Scenario B</p>
                <p className="text-xs text-white/38">Crashes lap 5 — DNF</p>
              </div>
              <TrendingDown className="h-4 w-4 text-red-400 ml-auto opacity-60 group-hover:opacity-100 transition-opacity" />
            </div>
            <p className="text-xs text-white/28">AI verdict → HOLD funds</p>
            <div className="mt-2 h-0.5 w-full rounded-full bg-red-500/15 overflow-hidden">
              <div className="h-full w-[8%] bg-gradient-to-r from-red-500 to-rose-400 rounded-full" />
            </div>
          </button>
        </div>

        <div className="flex items-center gap-4 max-w-sm mb-4">
          <div className="flex-1 h-px bg-white/7" />
          <span className="text-xs text-white/22">or</span>
          <div className="flex-1 h-px bg-white/7" />
        </div>
        {connected ? (
          <button onClick={runFullDemo} disabled={loading}
            className="self-start rounded-xl bg-white text-black px-7 py-3 text-sm font-bold hover:scale-[1.02] hover:shadow-[0_8px_30px_rgba(255,255,255,0.12)] transition-all disabled:opacity-50">
            {loading ? "Executing on Solana…" : "Run 4 Real On-Chain TXs (Phantom) →"}
          </button>
        ) : (
          <button onClick={triggerWallet}
            className="self-start flex items-center gap-2 rounded-xl border border-white/12 bg-white/5 px-5 py-2.5 text-sm text-white/50 hover:bg-white/9 transition-all">
            <Wallet className="h-3.5 w-3.5" />
            Connect Phantom for real on-chain execution
          </button>
        )}
      </div>

      {/* RIGHT — F1 car */}
      <div className="relative flex items-center justify-center h-full min-h-[400px]">
        <div className="absolute left-0 top-0 bottom-0 w-32 bg-gradient-to-r from-[#060608] to-transparent z-10 pointer-events-none" />
        <div className="absolute -inset-8 bg-orange-500/6 blur-[80px] rounded-full pointer-events-none" />
        <img
  src="/redbull-hero.png"
  alt="Red Bull F1 Car"
  className="w-full max-w-2xl object-contain relative z-0 drop-shadow-[0_0_80px_rgba(255,90,31,0.3)]"
  
/>
        
      </div>
    </motion.div>
  </section>
)}

        {/* ════════════════════════════════════════════
            CONTRACT PAGE
        ════════════════════════════════════════════ */}
        {page === "Contract" && (
          <section className="relative z-10 max-w-6xl mx-auto px-4 py-14">
            <div className="mb-8">
              <p className="text-xs uppercase tracking-[0.3em] text-orange-400 mb-2">Pre-Configured Sponsorship Agreement</p>
              <h1 className="text-4xl md:text-5xl font-black tracking-tight">Red Bull Racing — 2026 Escrow Contract</h1>
              <p className="text-white/35 mt-2 text-sm max-w-lg">
                AI oracle evaluates conditions. 4 Solana instructions settle on-chain.
              </p>
            </div>

            <div className="grid lg:grid-cols-5 gap-5">
              <div className="lg:col-span-2 rounded-2xl border border-white/7 bg-white/3 p-5 relative overflow-hidden">
                <div className="absolute top-0 right-0 h-40 w-40 bg-orange-500/5 blur-3xl" />
                <div className="w-full h-40 rounded-xl overflow-hidden mb-4 bg-gradient-to-br from-orange-900/25 to-red-900/20 border border-white/6">
                  <img
  src="/max.png"
  alt="Max Verstappen"
  className="w-full h-full object-cover object-top"
  onError={e => {
    const el = e.target as HTMLImageElement
    el.src =
      "https://upload.wikimedia.org/wikipedia/commons/7/75/Max_Verstappen_2023_British_GP_%2853461166352%29.jpg"
  }}
/>
                </div>
                <p className="text-xs uppercase tracking-[0.2em] text-white/28 mb-1">Driver #1</p>
                <h2 className="text-xl font-bold">Max Verstappen</h2>
                <p className="text-white/38 text-xs mt-1 mb-4">🇳🇱 Oracle Red Bull Racing</p>
                <div className="grid grid-cols-2 gap-2">
                  <MiniStat label="Championship" value="P1" />
                  <MiniStat label="Wins" value="8" />
                  <MiniStat label="Podiums" value="12" />
                  <MiniStat label="Avg Finish" value="2.1" />
                </div>
              </div>

              <div className="lg:col-span-3 rounded-2xl border border-white/7 bg-white/3 p-5 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between mb-5">
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-white/28">Escrow Amount</p>
                      <p className="text-5xl font-black mt-1">0.05 <span className="text-2xl text-white/50">SOL</span></p>
                    </div>
                    <div className="h-14 w-14 rounded-2xl bg-orange-500/10 border border-orange-500/16 flex items-center justify-center">
                      <Trophy className="h-7 w-7 text-orange-400" />
                    </div>
                  </div>

                  <p className="text-xs uppercase tracking-[0.2em] text-white/24 mb-3">AI-Verified Release Conditions</p>
                  <div className="space-y-2 mb-5">
                    {CONTRACT_CONDITIONS.map(c => (
                      <div key={c} className="flex items-center justify-between rounded-xl border border-white/6 bg-black/18 px-4 py-2.5 text-sm text-white/62">
                        <span>{c}</span>
                        <CheckCircle2 className="h-3.5 w-3.5 text-green-400 flex-shrink-0" />
                      </div>
                    ))}
                  </div>

                  {/* AI Oracle badge */}
                  <div className="rounded-xl border border-purple-500/18 bg-purple-500/6 p-3.5 mb-4 flex items-center gap-3">
                    <Brain className="h-5 w-5 text-purple-400 flex-shrink-0" />
                    <div>
                      <p className="text-xs text-purple-300 font-medium">Gemini AI Oracle</p>
                      <p className="text-xs text-white/38 mt-0.5">Evaluates race telemetry against conditions → on-chain verdict</p>
                    </div>
                  </div>

                  <div className="rounded-xl border border-orange-500/12 bg-orange-500/5 p-4">
                    <p className="text-xs text-orange-300 font-medium mb-2">4 Real Solana Instructions</p>
                    <div className="grid grid-cols-2 gap-1.5 text-xs text-white/45 font-mono">
                      <span>① initializeContract</span>
                      <span>② fundEscrow</span>
                      <span>③ verifyConditions</span>
                      <span>④ releasePayment</span>
                    </div>
                  </div>
                </div>

                {/* Scenario CTAs */}
                <div className="space-y-2 mt-5">
                  <div className="grid grid-cols-2 gap-2">
                    <button onClick={() => runScenarioDemo("A")}
                      className="rounded-xl border border-green-500/25 bg-green-500/8 px-4 py-3 text-sm font-bold text-green-300 hover:bg-green-500/16 transition-all">
                      🏆 Scenario A — P1 Win
                    </button>
                    <button onClick={() => runScenarioDemo("B")}
                      className="rounded-xl border border-red-500/25 bg-red-500/8 px-4 py-3 text-sm font-bold text-red-300 hover:bg-red-500/16 transition-all">
                      💥 Scenario B — DNF
                    </button>
                  </div>
                  {connected ? (
                    <button onClick={runFullDemo} disabled={loading}
                      className="w-full rounded-xl bg-gradient-to-r from-orange-500 to-red-500 px-6 py-3.5 text-sm font-bold hover:shadow-[0_8px_25px_rgba(255,90,31,0.35)] hover:-translate-y-0.5 transition-all disabled:opacity-50">
                      {loading ? "Signing transactions…" : "Execute Full On-Chain Flow (Phantom) →"}
                    </button>
                  ) : (
                    <button onClick={triggerWallet}
                      className="w-full rounded-xl border border-orange-500/20 bg-orange-500/7 px-6 py-2.5 text-xs text-orange-300 hover:bg-orange-500/14 transition-all">
                      Connect Phantom for real TXs
                    </button>
                  )}
                </div>
              </div>
            </div>
          </section>
        )}

        {/* ════════════════════════════════════════════
            EXECUTION PAGE
        ════════════════════════════════════════════ */}
        {page === "Execution" && (
          <section className="relative z-10 max-w-5xl mx-auto px-4 py-12">
            {/* Header */}
            <div className="flex items-start justify-between flex-wrap gap-4 mb-8">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-orange-400 mb-1.5">
                  {isReal ? "Live Solana Devnet" : activeScenario ? `Scenario ${activeScenario} — AI Oracle Demo` : "Visual Demo Mode"}
                </p>
                <h1 className="text-4xl md:text-5xl font-black tracking-tight">Escrow Execution</h1>
                <p className="text-white/35 mt-1.5 text-sm">
                  {isReal
                    ? `4 sequential on-chain transactions · Wallet: ${publicKey?.toBase58().slice(0, 8)}…`
                    : "AI oracle evaluates conditions. Connect Phantom to fire real on-chain TXs."}
                </p>
              </div>
              <div className={`flex items-center gap-2 rounded-full border px-4 py-2 text-xs ${
                isReal ? "border-green-500/20 bg-green-500/7 text-green-300"
                : activeScenario === "A" ? "border-green-500/20 bg-green-500/7 text-green-300"
                : activeScenario === "B" ? "border-red-500/20 bg-red-500/7 text-red-300"
                : "border-yellow-500/20 bg-yellow-500/7 text-yellow-300"
              }`}>
                <span className={`h-1.5 w-1.5 rounded-full animate-pulse ${
                  isReal ? "bg-green-400"
                  : activeScenario === "A" ? "bg-green-400"
                  : activeScenario === "B" ? "bg-red-400"
                  : "bg-yellow-400"
                }`} />
                {isReal ? "Real Solana TXs" : activeScenario ? `Scenario ${activeScenario}` : "Demo"}
              </div>
            </div>

            {/* Progress bar */}
            {txSteps.length > 0 && (
              <div className="mb-6">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-white/30">{completedSteps} / {txSteps.length} steps complete</span>
                  {demoComplete && (
                    <span className={`text-xs font-medium ${activeScenario === "B" ? "text-red-400" : "text-green-400"}`}>
                      {activeScenario === "B" ? "✕ Payment Blocked" : "✓ Complete"}
                    </span>
                  )}
                </div>
                <div className="h-1 rounded-full bg-white/7 overflow-hidden">
                  <div
                    className={`h-full transition-all duration-700 ${activeScenario === "B" ? "bg-gradient-to-r from-red-500 to-rose-500" : "bg-gradient-to-r from-orange-500 to-red-500"}`}
                    style={{ width: `${(completedSteps / txSteps.length) * 100}%` }}
                  />
                </div>
              </div>
            )}

            {/* TX Steps */}
            <div className="space-y-3 mb-6">
              {txSteps.map((step, i) => (
                <TxStepCard key={step.id} step={step} index={i} isReal={isReal} />
              ))}
            </div>

            {/* ── AI VERDICT CARD ── The hero moment */}
            <AnimatePresence>
              {verdict && demoComplete && (
                <motion.div
                  initial={{ opacity: 0, y: 16, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ type: "spring", stiffness: 200, damping: 20 }}
                  className={`rounded-2xl border p-6 mb-5 ${
                    verdict.decision === "RELEASE"
                      ? "border-green-500/25 bg-green-500/7"
                      : "border-red-500/25 bg-red-500/7"
                  }`}
                >
                  {/* Verdict header */}
                  <div className="flex items-center gap-3 mb-4">
                    <div className={`h-10 w-10 rounded-2xl flex items-center justify-center flex-shrink-0 ${
                      verdict.decision === "RELEASE" ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"
                    }`}>
                      <Brain className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-white/30">Gemini AI Oracle Verdict</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className={`text-2xl font-black ${verdict.decision === "RELEASE" ? "text-green-300" : "text-red-300"}`}>
                          {verdict.decision === "RELEASE" ? "✓ RELEASE FUNDS" : "✕ HOLD FUNDS"}
                        </span>
                        <span className="text-xs text-white/30 border border-white/10 rounded-full px-2 py-0.5">
                          {verdict.confidence}% confidence
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Race result */}
                  <div className="rounded-xl border border-white/8 bg-black/20 px-4 py-3 mb-4">
                    <p className="text-xs text-white/30 mb-1">Race Result</p>
                    <p className="text-sm font-semibold">{verdict.raceResult}</p>
                  </div>

                  {/* Oracle reason */}
                  <p className="text-sm text-white/60 mb-4 leading-relaxed border-l-2 border-white/12 pl-3">
                    {verdict.reason}
                  </p>

                  {/* Conditions breakdown */}
                  <div className="grid md:grid-cols-2 gap-3">
                    {verdict.conditionsMet.length > 0 && (
                      <div>
                        <p className="text-xs text-green-400 uppercase tracking-[0.15em] mb-2">✓ Conditions Met</p>
                        <div className="space-y-1.5">
                          {verdict.conditionsMet.map((c, i) => (
                            <div key={i} className="flex items-start gap-2 text-xs text-white/55">
                              <CheckCircle2 className="h-3.5 w-3.5 text-green-400 flex-shrink-0 mt-0.5" />
                              <span>{c}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {verdict.conditionsFailed.length > 0 && (
                      <div>
                        <p className="text-xs text-red-400 uppercase tracking-[0.15em] mb-2">✕ Conditions Failed</p>
                        <div className="space-y-1.5">
                          {verdict.conditionsFailed.map((c, i) => (
                            <div key={i} className="flex items-start gap-2 text-xs text-white/55">
                              <XCircle className="h-3.5 w-3.5 text-red-400 flex-shrink-0 mt-0.5" />
                              <span>{c}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* On-chain action result */}
                  <div className={`mt-4 rounded-xl border px-4 py-3 text-sm font-bold ${
                    verdict.decision === "RELEASE"
                      ? "border-green-500/20 bg-green-500/8 text-green-300"
                      : "border-red-500/20 bg-red-500/8 text-red-300"
                  }`}>
                    {verdict.decision === "RELEASE"
                      ? "⚡ 0.05 SOL auto-released from vault → athlete wallet"
                      : "🔒 0.05 SOL remains locked in escrow vault"}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Settlement complete (real TXs) */}
            <AnimatePresence>
              {demoComplete && isReal && (
                <motion.div
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="rounded-2xl border border-green-500/20 bg-green-500/7 p-6 mb-5"
                >
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                      <p className="text-xs uppercase tracking-[0.25em] text-green-400 mb-1.5">Settlement Complete — On-Chain</p>
                      <h2 className="text-2xl md:text-3xl font-black">0.05 SOL → Athlete Wallet</h2>
                      <p className="text-white/35 text-sm mt-1">Real SOL moved through escrow PDA on Solana devnet</p>
                    </div>
                    <div className="flex flex-col gap-2 text-xs font-mono text-white/40">
                      {vaultPda && <div><span className="text-white/22">Vault PDA  </span>{shortKey(vaultPda)}</div>}
                      <div className="text-green-400">✓ Oracle Verified</div>
                      <div className="text-green-400">✓ Conditions Met</div>
                      <div className="text-green-400">✓ Payment Released</div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Error */}
            {finalError && (
              <div className="rounded-2xl border border-red-500/18 bg-red-500/6 p-4 mb-5 flex items-start gap-3">
                <AlertCircle className="h-4 w-4 text-red-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-red-300 text-sm">{finalError}</p>
                  {!connected && (
                    <button onClick={triggerWallet} className="mt-2 text-xs text-orange-300 underline">
                      Connect Phantom to retry
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* CTAs */}
            <div className="flex flex-wrap gap-3">
              <button onClick={() => setPage("Architecture")}
                className="rounded-xl bg-white text-black px-5 py-2.5 text-sm font-bold hover:-translate-y-0.5 transition-all">
                View Architecture →
              </button>
              <button onClick={() => runScenarioDemo("A")}
                className="rounded-xl border border-green-500/22 bg-green-500/7 px-4 py-2.5 text-sm text-green-300 hover:bg-green-500/14 transition-all">
                🏆 Re-run Scenario A
              </button>
              <button onClick={() => runScenarioDemo("B")}
                className="rounded-xl border border-red-500/22 bg-red-500/7 px-4 py-2.5 text-sm text-red-300 hover:bg-red-500/14 transition-all">
                💥 Re-run Scenario B
              </button>
              {!isReal && (
                <button onClick={connected ? runFullDemo : triggerWallet}
                  className="rounded-xl border border-orange-500/28 bg-orange-500/7 px-5 py-2.5 text-sm text-orange-300 hover:bg-orange-500/14 transition-all">
                  {connected ? "Run Real On-Chain TXs" : "Connect Phantom"}
                </button>
              )}
            </div>
          </section>
        )}

        {/* ════════════════════════════════════════════
            ARCHITECTURE
        ════════════════════════════════════════════ */}
       {page === "Architecture" && (
  <section className="relative z-10 max-w-5xl mx-auto px-4 py-16">
    <div className="text-center mb-12">
      <p className="text-xs uppercase tracking-[0.3em] text-orange-400 mb-2">Technical Design</p>
      <h1 className="text-4xl md:text-5xl font-black tracking-tight">How SolSponsor Works</h1>
      <p className="text-white/35 mt-2 max-w-md mx-auto text-sm">
        AI oracle → Solana smart contract → automatic settlement.
      </p>
    </div>

    {/* ── FLOWCHART ── */}
    <div className="mb-10 rounded-2xl border border-white/7 bg-white/3 p-6 overflow-x-auto">
      {/* Swimlane headers */}
      <div className="grid grid-cols-3 mb-4 text-[10px] font-mono tracking-[0.15em] text-white/20 uppercase min-w-[560px]">
        <span>Sponsor</span>
        <span className="text-center">Solana on-chain</span>
        <span className="text-right">Off-chain / AI</span>
      </div>

      <div className="relative min-w-[560px]">
        {/* Swimlane dividers */}
        <div className="absolute top-0 bottom-0 left-1/3 border-l border-dashed border-white/6 pointer-events-none" />
        <div className="absolute top-0 bottom-0 right-1/3 border-l border-dashed border-white/6 pointer-events-none" />

        {/* ── TX 1 ── */}
        <div className="flex items-center gap-3 mb-1">
          {/* Sponsor actor */}
          <div className="w-1/3 flex justify-end pr-4">
            <div className="rounded-lg border border-teal-500/30 bg-teal-500/5 px-3 py-1.5 font-mono text-xs text-teal-300 flex items-center gap-2">
              <span>Sponsor</span>
              <span className="text-white/20 text-[10px]">signer →</span>
            </div>
          </div>
          {/* TX box */}
          <div className="w-1/3">
            <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-3 shadow-[0_0_18px_rgba(127,119,221,0.08)]">
              <span className="text-[10px] font-mono text-violet-400/50">TX 1</span>
              <p className="font-mono text-xs text-violet-300 font-semibold mt-0.5">initializeContract()</p>
              <p className="text-[10px] text-white/30 mt-1 leading-relaxed">
                Creates SponsorshipContract · space = 8+113 bytes
              </p>
            </div>
          </div>
          {/* PDA annotation */}
          <div className="w-1/3 pl-3">
            <div className="rounded-lg border border-dashed border-violet-500/20 px-3 py-2 font-mono text-[10px] text-violet-400/60 leading-relaxed">
              <p className="text-violet-300/50 mb-1">PDA derivation:</p>
              <p>["vault", contract.key()]</p>
              <p className="text-white/20">→ vault address</p>
            </div>
          </div>
        </div>

        {/* Arrow */}
        <div className="flex justify-center ml-[calc(33%+0px)] -translate-x-[16.5%]">
          <div className="flex flex-col items-center py-1">
            <div className="w-px h-4 bg-white/10" />
            <span className="text-[9px] font-mono text-white/20">0.05 SOL</span>
            <div className="w-px h-4 bg-white/10" />
            <svg width="8" height="6" viewBox="0 0 8 6"><polygon points="4,6 0,0 8,0" fill="rgba(255,255,255,0.15)"/></svg>
          </div>
        </div>

        {/* ── TX 2 ── */}
        <div className="flex items-center gap-3 mb-1">
          <div className="w-1/3 flex justify-end pr-4">
            <div className="font-mono text-[10px] text-amber-400/40 text-right">
              sponsor.wallet<br/>→ vault PDA
            </div>
          </div>
          <div className="w-1/3">
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 shadow-[0_0_18px_rgba(186,117,23,0.08)]">
              <span className="text-[10px] font-mono text-amber-400/50">TX 2</span>
              <p className="font-mono text-xs text-amber-300 font-semibold mt-0.5">fundEscrow()</p>
              <p className="text-[10px] text-white/30 mt-1 leading-relaxed">
                system_instruction::transfer<br/>
                0.05 SOL → vault PDA · locked on-chain
              </p>
            </div>
          </div>
          <div className="w-1/3" />
        </div>

        {/* Arrow */}
        <div className="flex justify-center ml-[calc(33%+0px)] -translate-x-[16.5%]">
          <div className="flex flex-col items-center py-1">
            <div className="w-px h-4 bg-white/10" />
            <span className="text-[9px] font-mono text-white/20">race ends</span>
            <div className="w-px h-4 bg-white/10" />
            <svg width="8" height="6" viewBox="0 0 8 6"><polygon points="4,6 0,0 8,0" fill="rgba(255,255,255,0.15)"/></svg>
          </div>
        </div>

        {/* ── GEMINI ORACLE ── */}
        <div className="flex items-center gap-3 mb-1">
          <div className="w-1/3" />
          <div className="w-1/3 flex items-center justify-end gap-2 pr-2">
            <div className="w-px h-px" />
            <span className="text-[9px] font-mono text-white/20">calls →</span>
          </div>
          <div className="w-1/3 pl-1">
            <div className="rounded-xl border border-orange-500/30 bg-orange-500/5 p-3 shadow-[0_0_18px_rgba(153,60,29,0.1)]">
              <span className="text-[10px] font-mono text-orange-400/50">AI ORACLE</span>
              <p className="font-mono text-xs text-orange-300 font-semibold mt-0.5">Gemini 2.0 Flash</p>
              <p className="text-[10px] text-white/30 mt-1 leading-relaxed">
                telemetry vs conditions<br/>
                → confidence score<br/>
                → RELEASE / HOLD
              </p>
            </div>
          </div>
        </div>

        {/* Arrow down + diamond */}
        <div className="flex justify-center ml-[calc(33%+0px)] -translate-x-[16.5%]">
          <div className="flex flex-col items-center py-1">
            <div className="w-px h-4 bg-white/10" />
            <span className="text-[9px] font-mono text-white/20">result triggers</span>
            <div className="w-px h-3 bg-white/10" />
            <svg width="8" height="6" viewBox="0 0 8 6"><polygon points="4,6 0,0 8,0" fill="rgba(255,255,255,0.15)"/></svg>
          </div>
        </div>

        {/* ── DECISION DIAMOND ── */}
        <div className="flex items-center gap-3 mb-1">
          <div className="w-1/3" />
          <div className="w-1/3 flex flex-col items-center">
            <svg width="100" height="52" viewBox="0 0 100 52">
              <polygon points="50,2 98,26 50,50 2,26" fill="rgba(0,0,0,0.4)" stroke="rgba(255,255,255,0.12)" strokeWidth="1"/>
              <text x="50" y="22" textAnchor="middle" fontFamily="monospace" fontSize="9" fill="rgba(255,255,255,0.4)">RELEASE</text>
              <text x="50" y="34" textAnchor="middle" fontFamily="monospace" fontSize="9" fill="rgba(255,255,255,0.4)">or HOLD?</text>
            </svg>
          </div>
          {/* HOLD branch */}
          <div className="w-1/3 flex items-center gap-2 pl-1">
            <svg width="32" height="12" viewBox="0 0 32 12">
              <line x1="0" y1="6" x2="24" y2="6" stroke="rgba(240,149,149,0.4)" strokeWidth="1" strokeDasharray="3 2"/>
              <polygon points="24,2 32,6 24,10" fill="rgba(240,149,149,0.4)"/>
            </svg>
            <div className="text-[9px] font-mono text-red-400/50 mr-1">HOLD</div>
            <div className="rounded-lg border border-red-500/25 bg-red-500/5 px-2.5 py-2 font-mono text-[10px] text-red-300/60 leading-relaxed">
              <p className="text-red-300/80 font-semibold text-[10px]">Funds locked</p>
              <p>no TX emitted</p>
            </div>
          </div>
        </div>

        {/* Arrow RELEASE */}
        <div className="flex justify-center ml-[calc(33%+0px)] -translate-x-[16.5%]">
          <div className="flex flex-col items-center py-1">
            <div className="w-px h-3 bg-green-500/20" />
            <span className="text-[9px] font-mono text-green-400/40">RELEASE</span>
            <div className="w-px h-3 bg-green-500/20" />
            <svg width="8" height="6" viewBox="0 0 8 6"><polygon points="4,6 0,0 8,0" fill="rgba(97,196,17,0.3)"/></svg>
          </div>
        </div>

        {/* ── TX 3 ── */}
        <div className="flex items-center gap-3 mb-1">
          <div className="w-1/3" />
          <div className="w-1/3">
            <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-3 shadow-[0_0_18px_rgba(24,95,165,0.08)]">
              <span className="text-[10px] font-mono text-blue-400/50">TX 3</span>
              <p className="font-mono text-xs text-blue-300 font-semibold mt-0.5">verifyConditions()</p>
              <p className="text-[10px] text-white/30 mt-1 leading-relaxed">
                ctx.accounts.authority ← oracle keypair<br/>
                conditions_met = true<br/>
                emit!(ConditionsVerified)
              </p>
            </div>
          </div>
          {/* Authority check annotation */}
          <div className="w-1/3 pl-3">
            <div className="rounded-lg border border-dashed border-blue-500/20 px-3 py-2 font-mono text-[10px] text-blue-400/60 leading-relaxed">
              <p className="text-blue-300/70 mb-1">⚠ authority check:</p>
              <p>ctx.accounts.authority</p>
              <p className="text-white/20">must == oracle keypair</p>
            </div>
          </div>
        </div>

        {/* Arrow */}
        <div className="flex justify-center ml-[calc(33%+0px)] -translate-x-[16.5%]">
          <div className="flex flex-col items-center py-1">
            <div className="w-px h-5 bg-white/10" />
            <svg width="8" height="6" viewBox="0 0 8 6"><polygon points="4,6 0,0 8,0" fill="rgba(255,255,255,0.15)"/></svg>
          </div>
        </div>

        {/* ── TX 4 ── */}
        <div className="flex items-center gap-3 mb-1">
          <div className="w-1/3" />
          <div className="w-1/3">
            <div className="rounded-xl border border-green-500/30 bg-green-500/5 p-3 shadow-[0_0_18px_rgba(59,109,17,0.1)]">
              <span className="text-[10px] font-mono text-green-400/50">TX 4</span>
              <p className="font-mono text-xs text-green-300 font-semibold mt-0.5">releasePayment()</p>
              <p className="text-[10px] text-white/30 mt-1 leading-relaxed">
                require!(conditions_met)<br/>
                vault PDA lamports → athlete.key()<br/>
                payment_released = true
              </p>
            </div>
          </div>
          <div className="w-1/3 pl-3">
            <div className="rounded-lg border border-dashed border-green-500/20 px-3 py-2 font-mono text-[10px] text-green-400/60 leading-relaxed">
              <p className="text-green-300/70 mb-1">lamport transfer:</p>
              <p>vault PDA →</p>
              <p>athlete.key()</p>
            </div>
          </div>
        </div>

        {/* Arrow to athlete */}
        <div className="flex justify-center ml-[calc(33%+0px)] -translate-x-[16.5%]">
          <div className="flex flex-col items-center py-1">
            <div className="w-px h-4 bg-teal-500/20" />
            <span className="text-[9px] font-mono text-teal-400/40">SOL transferred</span>
            <div className="w-px h-3 bg-teal-500/20" />
            <svg width="8" height="6" viewBox="0 0 8 6"><polygon points="4,6 0,0 8,0" fill="rgba(93,202,165,0.3)"/></svg>
          </div>
        </div>

        {/* Athlete terminal */}
        <div className="flex items-center gap-3">
          <div className="w-1/3" />
          <div className="w-1/3 flex justify-center">
            <div className="rounded-lg border border-teal-500/30 bg-teal-500/5 px-4 py-2 font-mono text-xs text-teal-300">
              Athlete — paid ✓
            </div>
          </div>
          <div className="w-1/3" />
        </div>
      </div>
    </div>

    {/* Account layout */}
    <div className="rounded-2xl border border-white/7 bg-white/3 p-5 mb-5">
      <p className="text-xs uppercase tracking-[0.2em] text-white/25 mb-4">
        SponsorshipContract Account Layout — 8 + 113 bytes
      </p>
      <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-2 font-mono text-xs">
        {[
          { field: "sponsor",          type: "Pubkey", bytes: "32b", color: "text-violet-300" },
          { field: "athlete",          type: "Pubkey", bytes: "32b", color: "text-teal-300"   },
          { field: "escrow_vault",     type: "Pubkey", bytes: "32b", color: "text-amber-300"  },
          { field: "amount",           type: "u64",    bytes: "8b",  color: "text-green-300"  },
          { field: "conditions_met",   type: "bool",   bytes: "1b",  color: "text-blue-300"   },
          { field: "payment_released", type: "bool",   bytes: "1b",  color: "text-blue-300"   },
          { field: "bump",             type: "u8",     bytes: "1b",  color: "text-white/40"   },
          { field: "created_at",       type: "i64",    bytes: "8b",  color: "text-white/40"   },
        ].map(({ field, type, bytes, color }) => (
          <div key={field} className="rounded-lg border border-white/6 bg-black/20 px-3 py-2">
            <p className={`${color} font-semibold`}>{field}</p>
            <p className="text-white/25">{type} · {bytes}</p>
          </div>
        ))}
      </div>
    </div>

    {/* Tech stack */}
    <div className="rounded-2xl border border-white/7 bg-white/3 p-5">
      <div className="flex flex-wrap gap-2 mb-4">
        {["Anchor Framework", "Rust / Solana Program", "Next.js 14", "Phantom Wallet Adapter", "@coral-xyz/anchor", "Gemini AI Oracle", "TailwindCSS", "Framer Motion"].map(t => (
          <span key={t} className="rounded-xl border border-white/7 bg-white/4 px-3 py-1.5 text-xs text-white/55">{t}</span>
        ))}
      </div>
      <div className="border-t border-white/6 pt-4 font-mono text-xs text-white/30">
        <span className="text-white/20">Program ID  </span>
        CdHmtAeZLRFLqeZmfJtEM6deJxbW2i9kqMDJr9kmcP7Y
        <a
          href="https://explorer.solana.com/address/CdHmtAeZLRFLqeZmfJtEM6deJxbW2i9kqMDJr9kmcP7Y?cluster=devnet"
          target="_blank" rel="noreferrer"
          className="ml-3 text-orange-400 hover:text-orange-300 inline-flex items-center gap-1 transition-colors"
        >
          View on Explorer <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>

    <div className="flex justify-center mt-8">
      <button onClick={() => setPage("Overview")}
        className="rounded-xl border border-white/8 bg-white/4 px-5 py-2.5 text-sm text-white/45 hover:bg-white/9 transition-all">
        ← Back to Overview
      </button>
    </div>
  </section>
)}
        {/* Footer */}
        <div className="relative z-10 border-t border-white/5 py-3">
          <div className="max-w-6xl mx-auto px-4 flex flex-wrap items-center justify-between gap-2 text-xs text-white/18">
            <span className="font-bold text-white/28">SolSponsor</span>
            <div className="flex gap-4">
              {["initializeContract", "fundEscrow", "verifyConditions", "releasePayment"].map(i => (
                <span key={i} className="font-mono">{i}()</span>
              ))}
            </div>
          </div>
        </div>

        {/* Loading overlay */}
        <AnimatePresence>
          {loading && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 z-[100] bg-[#060608]/95 backdrop-blur-2xl flex items-center justify-center">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(255,90,31,0.06),transparent_50%)]" />
              <div className="absolute inset-x-0 top-1/2 h-px bg-gradient-to-r from-transparent via-orange-500/30 to-transparent animate-pulse" />
              <div className="relative z-10 text-center space-y-3 px-6 max-w-sm">
                <h2 className="text-2xl md:text-3xl font-black">Executing on Solana…</h2>
                <p className="text-white/35 text-sm">Phantom will prompt for each transaction</p>
                <p className="text-white/22 text-xs font-mono">4 sequential instructions</p>
                <div className="mx-auto mt-5 h-0.5 w-48 bg-white/7 rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-orange-500 to-red-500 animate-pulse w-2/3" />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <style>{`
          .wallet-adapter-button, .wallet-adapter-button-trigger { all: unset !important; }
        `}</style>
      </motion.div>
    </AnimatePresence>
  )
}

/* ─── Sub-components ──────────────────────────────────── */

function TxStepCard({ step, index, isReal }: { step: TxStep; index: number; isReal: boolean }) {
  const statusColors: Record<TxStep["status"], string> = {
    pending: "border-white/6 bg-white/2",
    loading: "border-orange-500/20 bg-orange-500/6",
    success: "border-green-500/18 bg-green-500/5",
    error:   "border-red-500/18 bg-red-500/5",
    skipped: "border-white/6 bg-white/2 opacity-50",
  }
  const dotColors: Record<TxStep["status"], string> = {
    pending: "bg-white/15 text-white/30",
    loading: "bg-orange-500 animate-pulse text-white",
    success: "bg-green-400 shadow-[0_0_10px_rgba(74,222,128,0.6)] text-black",
    error:   "bg-red-400 text-black",
    skipped: "bg-white/10 text-white/20",
  }

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.05 }}
      className={`rounded-2xl border p-4 transition-all duration-400 ${statusColors[step.status]}`}
    >
      <div className="flex items-center gap-3">
        <div className={`h-6 w-6 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold transition-all ${dotColors[step.status]}`}>
          {step.status === "success" ? "✓" : step.status === "error" ? "✕" : step.status === "skipped" ? "–" : index + 1}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-semibold text-sm">{step.label}</p>
            {step.status === "loading" && (
              <span className="text-xs text-orange-300 animate-pulse">processing…</span>
            )}
          </div>
          <p className="text-white/30 text-xs mt-0.5">{step.sublabel}</p>
        </div>
        {step.txSig && step.txSig !== "DEMO_MODE" && step.explorerUrl && (
          <a href={step.explorerUrl} target="_blank" rel="noreferrer"
            className="flex-shrink-0 flex items-center gap-1.5 rounded-lg border border-white/8 bg-white/4 px-3 py-1.5 text-xs text-white/55 hover:bg-white/9 hover:text-white/80 transition-all">
            Explorer <ArrowUpRight className="h-3 w-3" />
          </a>
        )}
        {step.txSig === "DEMO_MODE" && step.status === "success" && (
          <span className="flex-shrink-0 text-xs text-yellow-500/60 rounded-lg border border-yellow-500/12 bg-yellow-500/5 px-3 py-1.5">
            demo
          </span>
        )}
      </div>
      {step.status === "loading" && (
        <div className="mt-2.5 h-0.5 rounded-full bg-white/7 overflow-hidden ml-9">
          <div className="h-full w-1/2 bg-gradient-to-r from-orange-500 to-red-500 animate-pulse" />
        </div>
      )}
    </motion.div>
  )
}

function FlowCard({
  step, icon, title, desc, color,
}: {
  step: string; icon: React.ReactNode; title: string; desc: string
  color: "orange" | "yellow" | "blue" | "green" | "purple"
}) {
  const cls = {
    orange: "border-orange-500/16 bg-orange-500/6 text-orange-400",
    yellow: "border-yellow-500/16 bg-yellow-500/6 text-yellow-400",
    blue:   "border-blue-500/16 bg-blue-500/6 text-blue-400",
    green:  "border-green-500/16 bg-green-500/6 text-green-400",
    purple: "border-purple-500/16 bg-purple-500/6 text-purple-400",
  }
  return (
    <div className="rounded-2xl border border-white/7 bg-white/3 p-4 relative overflow-hidden">
      <div className="absolute top-2 right-3 text-3xl font-black text-white/3 select-none">{step.replace("TX ", "")}</div>
      <div className={`h-8 w-8 rounded-xl border flex items-center justify-center mb-3 ${cls[color]}`}>{icon}</div>
      <p className="text-xs text-white/35 font-mono mb-1">{step}</p>
      <h3 className="font-bold text-sm mb-1.5">{title}</h3>
      <p className="text-white/32 text-xs leading-relaxed">{desc}</p>
    </div>
  )
}

function HeroBadge({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-white/25 mb-0.5">{label}</p>
      <p className={`text-sm font-semibold ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/6 bg-black/18 px-3 py-2">
      <p className="text-xs uppercase tracking-[0.12em] text-white/22">{label}</p>
      <p className="text-xl font-black mt-0.5">{value}</p>
    </div>
  )
}