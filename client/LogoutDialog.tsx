import { useState } from 'react';
import { Modal } from './Modal';
import { ui } from './language';

export function LogoutDialog({onClose, onConfirm}: {onClose: () => void; onConfirm: () => Promise<void>}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError('');
    try { await onConfirm(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : ui('ログアウトできませんでした。', 'Could not sign out.')); }
    finally { setBusy(false); }
  }
  return <Modal title={ui('ログアウトしますか？', 'Sign out?')} closeDisabled={busy} onClose={onClose}>
    <div className="detail-section">{error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="outline-button" disabled={busy} onClick={onClose}>{ui('キャンセル', 'Cancel')}</button>
        <button type="button" className="primary-button" disabled={busy} onClick={() => void confirm()}>
          {busy ? ui('ログアウト中…', 'Signing out…') : ui('ログアウト', 'Sign out')}
        </button>
      </div>
    </div>
  </Modal>;
}
