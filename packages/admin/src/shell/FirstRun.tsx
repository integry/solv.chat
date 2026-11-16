import { type CreatedAssistant, NewAssistantForm } from "./NewAssistantForm.js";

export interface FirstRunProps {
  onCreated: (created: CreatedAssistant) => void;
}

/**
 * Shared empty state shown on every built-in screen while the organisation has
 * no assistant yet.
 */
export function FirstRun({ onCreated }: FirstRunProps) {
  return (
    <div className="screen first-run">
      <div className="screen-header">
        <div>
          <h1 id="first-run-title">Create your first assistant</h1>
          <p className="muted">
            An assistant answers your visitors' questions from the pages and notes you give it. Each
            one has its own sources, behaviour and chat widget for your site.
          </p>
        </div>
      </div>

      <NewAssistantForm
        idPrefix="first-run-assistant"
        className="switcher-form"
        labelledBy="first-run-title"
        autoFocus
        onCreated={onCreated}
      />

      <section aria-labelledby="first-run-next">
        <h2 id="first-run-next" className="first-run-subtitle">
          Next steps
        </h2>
        <ol className="first-run-steps">
          <li>Add sources: the pages and notes it answers from.</li>
          <li>Try it: ask a question in the Try it pane.</li>
          <li>Install the snippet on your site.</li>
        </ol>
      </section>
    </div>
  );
}
