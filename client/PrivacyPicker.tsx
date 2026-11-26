import { ui } from './language';
import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { Modal } from './Modal';

const choices = {
  address: ui("住所", "Address"), workplace: ui("勤務先", "Workplace"), finance: ui("収入・借金", "Income and debt"), health: ui("健康", "Health"), family: ui("家族構成", "Family"),
  real_name: ui("本名", "Legal name"), birthday: ui("生年月日", "Date of birth"), contact: ui("連絡先", "Contact information"), location: ui("現在地・行動範囲", "Location and usual places"),
  schedule: ui("予定", "Schedule"), school: ui("学校・学歴", "Education"), relationships: ui("交友・交際関係", "Friends and relationships"),
  social_accounts: ui("SNSアカウント", "Social accounts"), payment: ui("決済情報", "Payment information"), identity_documents: ui("本人確認書類", "Identity documents"),
  credentials: ui("ログイン情報", "Login credentials"),
};

export function PrivacyPicker({ initial, onClose, onDone }: {
  initial: string[]; onClose: () => void; onDone: (values: string[]) => void;
}) {
  const [selected, setSelected] = useState(initial);
  const [draft, setDraft] = useState('');
  const pending = draft.split(/[,，、\n]/u).map(s => s.trim()).filter(Boolean);
  const values = [...new Set([...selected, ...pending])];
  const error = values.length > 30 ? ui("合計30件まで選べます。", "Select up to 30 items.") :
    values.some(value => value.length > 100) ? ui("各項目は100文字以内で入力してください。", "Use up to 100 characters per item.") : '';
  function remove(value: string) { setSelected(selected.filter(item => item !== value)); }
  function add() { if (!error) { setSelected(values); setDraft(''); } }
  return <Modal title={ui("非公開にしたい情報", "Private information")} onClose={onClose}>
    <div className="modal-form privacy-options">
      <div className="check-grid">{Object.entries(choices).map(([value, label]) =>
        <label className="checkbox-label" key={value}><input type="checkbox" checked={selected.includes(value)}
          onChange={event => event.target.checked ? setSelected([...selected, value]) : remove(value)}/>{label}</label>)}</div>
      <label>{ui("その他の非公開情報", "Other private information")}<input value={draft} onChange={event => setDraft(event.target.value)}
        placeholder={ui("例：旅行先、ペットの名前", "e.g. destinations, pet names")} onKeyDown={event => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); add(); }
        }}/></label>
      {selected.some(value => !Object.hasOwn(choices, value)) && <div className="privacy-chips">{selected.filter(value => !Object.hasOwn(choices, value)).map(value =>
        <span className="tag-chip" key={value}>{value}<button type="button" aria-label={value + ui("を削除", " (delete)")} onClick={() => remove(value)}><X size={14}/></button></span>)}</div>}
      <small>{ui("指定した項目はエージェントに伝わります。投稿時の自動警告は住所・収入・健康に関する一部の表現が対象です。", "Your agent receives these preferences. Automatic posting warnings cover certain address, income and health information.")}</small>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="button" className="primary-button full" disabled={Boolean(error)} onClick={() => onDone(values)}>{ui("完了", "Done")} <Check size={17}/></button>
    </div>
  </Modal>;
}
