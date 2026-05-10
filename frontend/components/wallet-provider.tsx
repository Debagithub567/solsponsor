"use client"

import { FC, ReactNode, useMemo } from "react"

import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react"

import {
  WalletModalProvider,
} from "@solana/wallet-adapter-react-ui"

import {
  PhantomWalletAdapter,
} from "@solana/wallet-adapter-wallets"


const endpoint = "http://127.0.0.1:8899"

export const SolanaProvider: FC<{ children: ReactNode }> = ({
  children,
}) => {
  const wallets = useMemo(
    () => [new PhantomWalletAdapter()],
    []
  )

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          {children}
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}