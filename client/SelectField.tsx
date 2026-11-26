import { useCallback, useState, useSyncExternalStore } from 'react';
import * as Select from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { desktopSelect } from './desktop-select';

function subscribe(listener: () => void) {
  desktopSelect.addEventListener('change', listener);
  return () => desktopSelect.removeEventListener('change', listener);
}

type Props = {
  id?: string;
  name?: string;
  label: string;
  options: Readonly<Record<string, string>>;
  value?: string;
  defaultValue?: string;
  required?: boolean;
  onChange?: (value: string) => void;
};

export function SelectField({ id, name, label, options, value, defaultValue, required, onChange }: Props) {
  const custom = useSyncExternalStore(subscribe, () => desktopSelect.matches);
  const entries = Object.entries(options);
  const [localValue, setLocalValue] = useState(defaultValue ?? entries[0]?.[0]);
  const current = value ?? localValue;
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const attachTrigger = useCallback((node: HTMLButtonElement | null) => setDialog(node?.closest('dialog') ?? null), []);
  function choose(next: string) {
    if (value === undefined) setLocalValue(next);
    onChange?.(next);
  }

  if (!custom) return <span className="room-select-native">
    <select id={id} name={name} aria-label={label} value={current} required={required} onChange={e => choose(e.currentTarget.value)}>
      {entries.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
    </select>
  </span>;

  return <Select.Root name={name} value={current} onValueChange={choose} required={required}>
    <Select.Trigger id={id} ref={attachTrigger} aria-label={label} className="room-select-trigger">
      <Select.Value/><Select.Icon asChild><ChevronDown size={16} aria-hidden="true"/></Select.Icon>
    </Select.Trigger>
    <Select.Portal container={dialog}>
      <Select.Content className="room-select-popup" position="popper" align="start" sideOffset={5} collisionPadding={8}>
        <Select.Viewport className="room-select-options">
          {entries.map(([key, text]) => <Select.Item className="room-select-option" key={key} value={key}>
            <Select.ItemText>{text}</Select.ItemText>
            <Select.ItemIndicator><Check size={16} aria-hidden="true"/></Select.ItemIndicator>
          </Select.Item>)}
        </Select.Viewport>
      </Select.Content>
    </Select.Portal>
  </Select.Root>;
}
