import { LoginForm } from "./login-form";
import styles from "./login.module.css";

export const dynamic = "force-dynamic";

/** Public sign-in. The allowlisted address is not rendered here. */
export default function P6LoginPage() {
  return (
    <main className={styles.wrap}>
      <h1>P6 sign in</h1>
      <p className={styles.sub}>Read-only dashboard. Request a code for the address you use.</p>
      <LoginForm />
    </main>
  );
}
