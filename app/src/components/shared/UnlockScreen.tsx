import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export function UnlockScreen({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [isNew, setIsNew] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Determine once whether this is first-time setup or an unlock,
  // so we know whether to show the confirm-password field / warning.
  useState(() => {
    invoke<string>("cmd_check_encryption_status").then((status) => {
      setIsNew(status === "new");
    });
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (isNew && password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    if (isNew && password.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }

    setLoading(true);
    try {
      await invoke("cmd_unlock", { password });
      onSuccess();
    } catch (err) {
      setError(isNew ? `Setup failed: ${err}` : "Wrong password.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-telegram-bg text-telegram-text">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm p-8 rounded-2xl bg-telegram-surface border border-telegram-border flex flex-col gap-4"
      >
        <h1 className="text-lg font-semibold">
          {isNew ? "Create a master password" : "Enter your master password"}
        </h1>

        {isNew && (
          <p className="text-sm text-telegram-subtext">
            This encrypts your files. There is no way to recover this
            password — if you forget it, your files cannot be decrypted.
          </p>
        )}

        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="px-3 py-2 rounded-lg bg-telegram-bg border border-telegram-border outline-none focus:border-telegram-primary"
        />

        {isNew && (
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Confirm password"
            className="px-3 py-2 rounded-lg bg-telegram-bg border border-telegram-border outline-none focus:border-telegram-primary"
          />
        )}

        {error && <p className="text-sm text-red-500">{error}</p>}

        <button
          type="submit"
          disabled={loading || !password}
          className="mt-2 px-4 py-2 rounded-lg bg-telegram-primary text-white font-medium disabled:opacity-50"
        >
          {loading ? "Please wait..." : isNew ? "Create & Continue" : "Unlock"}
        </button>
      </form>
    </div>
  );
}