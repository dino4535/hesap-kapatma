import type { ReactNode } from 'react'

export function Modal(props: { title: string; open: boolean; onClose: () => void; children: ReactNode; size?: 'default' | 'large' | 'wide' }) {
  if (!props.open) return null
  const modalClass = props.size === 'wide' ? 'modal modal-wide' : props.size === 'large' ? 'modal modal-large' : 'modal'
  return (
    <div className="modal-backdrop" onClick={props.onClose} role="presentation">
      <div className={modalClass} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <div className="modal-title">{props.title}</div>
          <button className="modal-close" type="button" onClick={props.onClose}>
            ×
          </button>
        </div>
        {props.children}
      </div>
    </div>
  )
}
