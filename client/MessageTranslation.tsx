import { useState, type ReactNode } from 'react';
import { Languages } from 'lucide-react';
import { ApiError, publicRequest, request, type Message } from './api';
import { locale, ui } from './language';
import { Modal } from './Modal';

type Props = {
  message: Message;
  preview: boolean;
  children: (text: string, controls: ReactNode) => ReactNode;
};

export function MessageTranslation({ message, preview, children }: Props) {
  const [translation, setTranslation] = useState('');
  const [show, setShow] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function translate(confirmed: boolean) {
    setConsent(false);
    setBusy(true);
    setError('');
    try {
      const path = '/rooms/' + encodeURIComponent(message.room_id) + '/messages/' + encodeURIComponent(message.id) + '/translation';
      const fetcher = preview ? publicRequest : request;
      const result = await fetcher<{ translation: string }>(path, {
        method: 'POST', body: { target: locale, edited_at: message.edited_at, consent: confirmed },
      });
      setTranslation(result.translation);
      setShow(true);
    } catch (cause) {
      const status = cause instanceof ApiError ? cause.status : 0;
      if (status === 428) setConsent(true);
      else if (status === 429) setError(ui('翻訳の利用上限に達しました。時間をおいてお試しください。', 'Translation limit reached. Please try again later.'));
      else if (status === 409) setError(ui('少し待ってから、もう一度お試しください。', 'Please try again in a moment.'));
      else setError(ui('翻訳できませんでした。', 'Translation unavailable.'));
    } finally {
      setBusy(false);
    }
  }

  const controls = !message.media_label_only && message.body.trim() && <>
    <button type="button" className="message-translate" aria-pressed={show} disabled={busy}
      onClick={() => translation ? setShow(!show) : void translate(false)}>
      <Languages size={13} aria-hidden="true"/>
      {busy ? ui('翻訳中…', 'Translating…') : show ? ui('原文を表示', 'Show original') : ui('翻訳', 'Translate')}
    </button>
    {error && <span role="alert">{error}</span>}
    {consent && <Modal title={ui('この投稿を翻訳しますか？', 'Translate this private message?')} onClose={() => setConsent(false)}>
      <div className="detail-section confirmation-body"><p>{ui(
        'この投稿の本文をCloudflare Workers AIに送信して翻訳します。訳文はA2aroomに保存され、この投稿を閲覧できる人が利用できます。',
        'The text of this message will be sent to Cloudflare Workers AI for translation. A2aroom saves the translation for people who can read the message.'
      )}</p>
      <div className="dialog-actions"><button type="button" className="outline-button" onClick={() => setConsent(false)}>{ui('キャンセル', 'Cancel')}</button>
        <button type="button" className="primary-button" onClick={() => void translate(true)}>{ui('同意して翻訳', 'Agree and translate')}</button></div></div>
    </Modal>}
  </>;
  return children(show ? translation : message.body, controls);
}
