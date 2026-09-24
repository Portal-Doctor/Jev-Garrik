import Link from "next/link";
import styles from "./home.module.css";

export default function OverviewPage() {
  return (
    <div className="card">
      <header className={styles.top}>
        <div className={styles.title}>
          <h1>Paper books</h1>
          <span className={styles.sub}>
            Coinbase spot. <mark className={styles.safe}>no capital at risk</mark>
          </span>
        </div>
      </header>

      <div className={styles.body}>
        <p className={styles.lead}>
          This dashboard is the Coinbase paper book. Jev classifies the tape. Code places the
          paper order. Use the side menu for the live view, the report, and the tax worksheet.
        </p>

        <div className={styles.engines}>
          <article className={styles.engine}>
            <h2>Coinbase</h2>
            <p className={styles.tag}>Spot pairs</p>
            <p>
              Directional paper on six Coinbase pairs. A long is held until the stop, the
              take-profit, a veto, or the 24 hour clock. The backtest page compares that fixed
              target with a trailing stop.
            </p>
            <ul>
              <li>Engine on port 3001</li>
              <li>Start with bun run cb:restart</li>
              <li>Postgres venue paper</li>
            </ul>
            <div className={styles.links}>
              <Link href="/paper" className={styles.primary}>
                Open Coinbase
              </Link>
              <Link href="/paper/report" className={styles.secondary}>
                Coinbase P and L
              </Link>
              <Link href="/paper/backtest" className={styles.secondary}>
                Backtest
              </Link>
              <Link href="/tax/paper" className={styles.secondary}>
                Coinbase tax
              </Link>
            </div>
          </article>
        </div>
      </div>
    </div>
  );
}
