import { useId, type InputHTMLAttributes } from 'react';
type TextFieldProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'id' | 'aria-describedby' | 'aria-invalid'
> & { label: string; hint?: string; error?: string };
export function TextField({
  label,
  hint,
  error,
  className = '',
  ...props
}: TextFieldProps) {
  const id = useId();
  const describedBy =
    [hint ? `${id}-hint` : '', error ? `${id}-error` : '']
      .filter(Boolean)
      .join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        {...props}
        className={`field__input ${className}`}
        id={id}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
      />
      {hint && (
        <p id={`${id}-hint`} className="caption">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
