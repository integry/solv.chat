/** "12 / 500", and a warning tone once over the limit. */
export function CharCount({ id, value, max }: { id: string; value: string; max: number }) {
  const length = value.trim().length;
  const over = length > max;
  return (
    <span id={id} className={over ? "char-count char-count-over" : "char-count"}>
      {over ? `${length - max} characters too long (${length} / ${max})` : `${length} / ${max}`}
    </span>
  );
}
