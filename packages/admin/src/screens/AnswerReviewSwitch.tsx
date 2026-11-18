import { useState } from "react";
import { ApiError, putJson } from "../api/client.js";
import type { ProviderSettingsView } from "../api/types.js";
import { useToast } from "../ui/Toast.js";

export interface AnswerReviewSwitchProps {
  view: ProviderSettingsView;
  /** Receives the settings the engine answers with after a save. */
  onSaved: (view: ProviderSettingsView) => void;
}

/**
 * "Review answers" on Settings → Providers. Saved as soon as it is switched,
 * on its own, so it never sends the unsaved model choices above it.
 */
export function AnswerReviewSwitch({ view, onSaved }: AnswerReviewSwitchProps) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const setting = view.settings.reviewAnswers;
  // An engine without answer review sends no setting: nothing to switch.
  if (setting === undefined) return null;

  async function change(on: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      const updated = await putJson<ProviderSettingsView>("/api/admin/providers", {
        reviewAnswers: on,
      });
      onSaved(updated);
      toast.success(on ? "Answers will be reviewed." : "Answers will not be reviewed.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="source-card stack" aria-labelledby="answer-review-heading">
      <h2 id="answer-review-heading" className="section-heading">
        Answer review
      </h2>
      <div className="field">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={setting.value}
            disabled={busy}
            onChange={(e) => void change(e.target.checked)}
          />
          <span>Review answers</span>
        </label>
        <span className="field-hint">
          After each answer is sent, a quick check decides whether it really answered the visitor,
          so Gaps and the answered share are right. It uses a small amount of your model budget per
          answer.
        </span>
      </div>
    </section>
  );
}
