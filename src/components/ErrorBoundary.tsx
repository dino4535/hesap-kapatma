import { Component, type ReactNode } from 'react'

type Props = {
  children: ReactNode
}

type State = {
  hasError: boolean
  message: string
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' }

  static getDerivedStateFromError(error: unknown): State {
    const message = error instanceof Error ? error.message : 'Bilinmeyen hata'
    return { hasError: true, message }
  }

  render() {
    if (!this.state.hasError) return this.props.children
    return (
      <div style={{ padding: 16, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif' }}>
        <h2 style={{ margin: 0, marginBottom: 8 }}>Beklenmeyen bir hata oluştu</h2>
        <div style={{ marginBottom: 12, color: '#4a5568' }}>{this.state.message}</div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #CBD5E0', background: '#fff' }}
        >
          Sayfayı Yenile
        </button>
      </div>
    )
  }
}
