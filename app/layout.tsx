import type { Metadata } from "next"
import { Geist, Fraunces, Instrument_Serif } from "next/font/google"
import "./globals.css"

const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" })

// Body serif — Tiempos-adjacent. opsz axis means it works at any size.
const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  display: "swap",
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
})

// Display serif — for brand wordmark and h1. Narrow, editorial,
// italic has the swashes that give the page its character.
const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  variable: "--font-instrument",
  display: "swap",
  weight: ["400"],
  style: ["normal", "italic"],
})

export const metadata: Metadata = {
  title: "persona",
  description: "agentic adaptive retrieval over your real memories",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${fraunces.variable} ${instrumentSerif.variable}`}>
      <body>{children}</body>
    </html>
  )
}
