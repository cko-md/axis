"use client";
import { useEffect } from "react";
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error) }, [error])
  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100vh", gap:16, color:"var(--ink)", fontFamily:"var(--mono)" }}>
      <div style={{ fontSize:10, textTransform:"uppercase", letterSpacing:".12em", color:"var(--ink-faint)" }}>System Error</div>
      <div style={{ fontSize:14, color:"var(--ink-dim)", maxWidth:320, textAlign:"center", lineHeight:1.6 }}>{error.message || "Something went wrong"}</div>
      <button onClick={reset} style={{ padding:"6px 16px", border:"1px solid var(--line)", borderRadius:"var(--r)", background:"transparent", color:"var(--ink)", fontSize:11, fontFamily:"var(--mono)", cursor:"pointer", letterSpacing:".06em" }}>Retry</button>
    </div>
  )
}
