import {
  useId,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
export function SelectField({
  label,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select {...props} id={id} className="field__input">
        {children}
      </select>
    </div>
  );
}
export function TextArea({
  label,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea {...props} id={id} className="field__input" rows={4} />
    </div>
  );
}
