import Link from "next/link";
import styles from "./home.module.css";

export default function OverviewPage() {
  return (
    <div className="card">
      <header className={styles.top}>
        <div className={styles.title}>
          <h1>Paper books</h1>
          <span className={styles.sub}>
            Two engines. Jev still picks the side. <mark className={styles.safe}>no capital at risk</mark>
          </span>
        </div>
      </header>

      <div className={styles.body}>
        <p className={styles.lead}>
          This dashboard is for the paper soak, not the public tweet demo. Each engine writes its own
          book and P and L. Use the side menu to move between live views and reports.
        </p>

        <div className={styles.engines}>
          <article className={styles.engine}>
            <h2>Kuru</h2>
            <p className={styles.tag}>Monad on-chain book</p>
            <p>
              Two-sided maker quotes on MON-USDC. Jev chooses buy or sell from the price feed. The
              engine posts on Kuru and only counts a paper fill when a real print crosses the resting
              quote. Fees and a 0.5 percent haircut are applied so the report is honest.
            </p>
            <ul>
              <li>Dashboard on port 3002</li>
              <li>Start with bun run kuru:start</li>
              <li>Promotion gate before any live size</li>
            </ul>
            <div className={styles.links}>
              <Link href="/kuru" className={styles.primary}>
                Open Kuru
              </Link>
              <Link href="/kuru/report" className={styles.secondary}>
                Kuru P and L
              </Link>
              <Link href="/tax/kuru" className={styles.secondary}>
                Kuru tax
              </Link>
            </div>
          </article>

          <article className={styles.engine}>
            <h2>Coinbase</h2>
            <p className={styles.tag}>Spot pairs</p>
            <p>
              Directional paper on Coinbase spot. Jev decides buy or sell from each pair feed. The
              book measures edge after fees and holds the position through 30 second, 5 minute, and
              30 minute reads.
            </p>
            <ul>
              <li>Dashboard on port 3001</li>
              <li>Start with bun run cb:restart</li>
              <li>Same Postgres, venue paper</li>
            </ul>
            <div className={styles.links}>
              <Link href="/paper" className={styles.primary}>
                Open Coinbase
              </Link>
              <Link href="/paper/report" className={styles.secondary}>
                Coinbase P and L
              </Link>
              <Link href="/tax/paper" className={styles.secondary}>
                Coinbase tax
              </Link>
            </div>
          </article>
        </div>

        <section className={styles.note}>
          <h2>Why the root Jev Trader is off</h2>
          <p>
            The original tweet path placed an order on every 300 ms Monad block and kept a live
            dashboard at this URL. That loop is not needed for paper measurement and it spent a
            full book cycle plus a Jev call we already run inside the Kuru maker engine. The public
            demo is not started here.
          </p>
        </section>
      </div>
    </div>
  );
}
