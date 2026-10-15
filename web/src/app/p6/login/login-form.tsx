"use client";

import { useState } from "react";
import styles from "./login.module.css";

const SENT = "If that address can sign in, a code is on its way.";
const REJECTED = "That code was not accepted.";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);

  async function sendCode(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    try {
      await fetch("/api/p6/login/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
    } catch {
      // The notice stays the same when the request fails.
    }
    setNotice(SENT);
    setPending(false);
  }

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    try {
      const res = await fetch("/api/p6/login/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      if (res.ok) {
        window.location.assign("/p6");
        return;
      }
    } catch {
      // Fall through to the same rejection notice.
    }
    setNotice(REJECTED);
    setPending(false);
  }

  return (
    <>
      <form className={styles.form} onSubmit={sendCode}>
        <label>
          Email
          <input
            type="email"
            name="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <button type="submit" disabled={pending}>
          Send code
        </button>
      </form>
      <form className={styles.form} onSubmit={signIn}>
        <label>
          Code
          <input
            type="text"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
          />
        </label>
        <button type="submit" disabled={pending}>
          Sign in
        </button>
      </form>
      <p className={styles.notice} role="status">
        {notice}
      </p>
    </>
  );
}
