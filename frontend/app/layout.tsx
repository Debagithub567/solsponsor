import "./globals.css"

import type { Metadata } from "next"

import { SolanaProvider } from "../components/wallet-provider"

export const metadata: Metadata = {
  title: "Solsponsor",
  description: "Automated Solana Sponsorship Infrastructure",
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>
        <SolanaProvider>
          {children}
        </SolanaProvider>
      </body>
    </html>
  )
}