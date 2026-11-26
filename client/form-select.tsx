import '@vitejs/plugin-react/preamble';
import { desktopSelect } from './desktop-select';

// Keep the Worker-rendered form usable before scripts load and on touch devices.
async function enhance() {
  if (!desktopSelect.matches) return;
  desktopSelect.removeEventListener('change', enhance);
  const [{ createRoot }, { SelectField }] = await Promise.all([import('react-dom/client'), import('./SelectField')]);

  for (const host of document.querySelectorAll<HTMLElement>('[data-select-field]')) {
    const field = host.querySelector('select');
    const label = field?.labels?.[0]?.textContent?.trim();
    if (!field || !label) continue;
    const options = Object.fromEntries(Array.from(field.options, option => [option.value, option.text]));
    createRoot(host).render(<SelectField id={field.id} name={field.name} label={label}
      defaultValue={field.value} required={field.required} options={options}/>);
  }
}
desktopSelect.addEventListener('change', enhance);
void enhance();
