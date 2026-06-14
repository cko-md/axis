export default function NotFound() {
  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100vh", gap:12, color:"var(--ink)", fontFamily:"var(--mono)" }}>
      <div style={{ fontSize:10, textTransform:"uppercase", letterSpacing:".12em", color:"var(--ink-faint)" }}>404</div>
      <div style={{ fontSize:14, color:"var(--ink-dim)" }}>Page not found</div>
    </div>
  )
}
