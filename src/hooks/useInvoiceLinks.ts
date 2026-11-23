import { useEffect, useState } from 'react'
import { getShareBase } from '@/lib/share'
import { encodeInvoice, invoicePath } from '@/lib/invoice/codec'
import type { SignedInvoice } from '@/lib/invoice/types'

export interface InvoiceLinks {
  /** Short link without image previews: also what the QR code holds. */
  compact?: string
  /** Link that also carries the image previews (only when there are images). */
  full?: string
  fullChars: number
  error?: boolean
}

/** Builds the shareable links for an invoice using the app's public share address, never window.location. */
export function useInvoiceLinks(signed: SignedInvoice, images: string[]): InvoiceLinks {
  const [links, setLinks] = useState<InvoiceLinks & { key?: string }>({ fullChars: 0 })
  const key = signed.data.id + signed.signature + images.length

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const base = await getShareBase()
        const compact = base + invoicePath(await encodeInvoice(signed))
        const full = images.length ? base + invoicePath(await encodeInvoice(signed, images)) : undefined
        if (alive) setLinks({ key, compact, full, fullChars: full?.length ?? 0 })
      } catch {
        if (alive) setLinks({ key, fullChars: 0, error: true })
      }
    })()
    return () => {
      alive = false
    }
  }, [key, signed, images])

  return links.key === key ? links : { fullChars: 0 }
}
