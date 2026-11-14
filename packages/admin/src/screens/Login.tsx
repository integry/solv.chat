import { type FormEvent, useState } from "react";
import { ApiError, loginRequest } from "../api/client.js";

export interface LoginProps {
  onSignedIn: () => void;
}

export function Login({ onSignedIn }: LoginProps) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const submittedPassword = password;
    // Clear password from state immediately on submit so it is never retained.
    setPassword("");
    setError(null);
    setSubmitting(true);

    try {
      await loginRequest(submittedPassword);
      onSignedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign-in failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>Sign in</h1>
        <p className="muted">Enter your admin password to manage your assistants.</p>
        <form onSubmit={handleSubmit} className="stack">
          <div className="field">
            <label htmlFor="admin-password">Password</label>
            <input
              id="admin-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              required
            />
          </div>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
