import {
  AnchorProvider,
  Program,
  Idl,
} from "@coral-xyz/anchor"

import {
  Connection,
  PublicKey,
} from "@solana/web3.js"

import idl from "../../idl/backend.json"

export const PROGRAM_ID = new PublicKey(
  "CdHmtAeZLRFLqeZmfJtEM6deJxbW2i9kqMDJr9kmcP7Y"
)

export const getConnection = () =>
  new Connection("https://api.devnet.solana.com", "confirmed")

export const deriveVaultPda = (contractPubkey: PublicKey): [PublicKey, number] =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), contractPubkey.toBuffer()],
    PROGRAM_ID
  )

export const getProgram = (wallet: any) => {
  const connection = getConnection()

  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  })

  return new Program(idl as Idl, provider)
}