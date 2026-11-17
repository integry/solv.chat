import { useId } from "react";

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string | number> {
  /** Accessible name of the group, e.g. "Period". */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}

/**
 * A row of mutually exclusive choices built on native radio buttons, so arrow
 * keys move between them and screen readers announce "1 of 3".
 */
export function SegmentedControl<T extends string | number>({
  label,
  options,
  value,
  onChange,
  className,
}: SegmentedControlProps<T>) {
  const name = useId();
  return (
    <fieldset className={className ? `segmented ${className}` : "segmented"}>
      <legend className="sr-only">{label}</legend>
      {options.map((option) => (
        <label
          key={String(option.value)}
          className={option.value === value ? "segmented-option is-selected" : "segmented-option"}
        >
          <input
            type="radio"
            name={name}
            className="segmented-input"
            checked={option.value === value}
            onChange={() => onChange(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}
