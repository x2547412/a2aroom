import { SelectField } from './SelectField';
import { chooseLanguage, languageOptions, setting, ui } from './language';

export function LanguageField() {
  return <SelectField name="language" label={ui('言語 / Language', 'Language / 日本語')} options={languageOptions} value={setting} onChange={chooseLanguage}/>;
}
