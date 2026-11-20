import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Catches render-time crashes anywhere below it and shows a visible message
 * instead of a blank page. Uses inline styles only so it never depends on
 * Tailwind, wagmi or ConnectKit being healthy.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('OrbitPay render error:', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div
        role="alert"
        style={{
          minHeight: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 14,
          padding: 24,
          textAlign: 'center',
          background: '#0b1628',
          color: '#f4f7fb',
          fontFamily: "'DM Sans', system-ui, sans-serif",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 22 }}>Something went wrong</h1>
        <p style={{ margin: 0, maxWidth: 360, fontSize: 14, lineHeight: 1.5, color: '#b4c2d6' }}>
          OrbitPay hit an unexpected error. Your funds are not affected. Reload to try again.
        </p>
        <pre
          style={{
            margin: 0,
            maxWidth: '90vw',
            maxHeight: 140,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            textAlign: 'left',
            fontSize: 11,
            color: '#f08592',
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 12,
            padding: '10px 12px',
          }}
        >
          {error.message}
        </pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{ height: 44, padding: '0 20px', border: 0, borderRadius: 14, background: '#acc6e9', color: '#0b1628', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}
        >
          Reload
        </button>
      </div>
    )
  }
}
