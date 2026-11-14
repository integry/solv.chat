export interface PlaceholderProps {
  title: string;
}

export function Placeholder({ title }: PlaceholderProps) {
  return (
    <div className="screen">
      <div className="screen-header">
        <div>
          <h1>{title}</h1>
          <p className="muted">This screen is not built yet.</p>
        </div>
      </div>
    </div>
  );
}
